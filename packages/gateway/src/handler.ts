/**
 * The Anthropic-compatible Messages handler.
 *
 * Deliberately transport-agnostic: it returns either a JSON message or an
 * async generator of SSE frames, so the same logic serves the HTTP route and
 * the tests.
 */

import {
  AnthropicApiError,
  invalidRequest,
  messageId as newMessageId,
  notFound,
  permissionDenied,
  authenticationError,
  rateLimited,
  toAnthropicError,
  upstreamError,
  validateMessagesRequest,
  type AnthropicMessage,
  type AnthropicStreamEvent,
  type MessagesRequest,
} from "@helix/contracts";
import {
  AnthropicStreamAssembler,
  conversationDigest,
  LocalModelClient,
  LocalModelUpstreamError,
  ThinkingSigner,
  toOpenAiRequest,
  type LocalModelFeatures,
} from "@helix/local-adapter";
import type { ModelDeployment } from "@helix/config";
import type { QuotaService } from "@helix/quota";
import type { Tool } from "@helix/contracts";
import { KeyStore, type VirtualKey } from "./keys.js";
import { ModelRouter } from "./router.js";
import { McpClient } from "./mcp-client.js";
import { runAgent } from "./agent.js";

export interface MessagesDeps {
  keys: KeyStore;
  router: ModelRouter;
  quota: QuotaService;
  signer: ThinkingSigner;
  /** Build a client for a deployment. */
  clientFor: (deployment: ModelDeployment) => LocalModelClient;
  /** Feature detection per deployment. */
  featuresFor?: (deployment: ModelDeployment) => LocalModelFeatures;
  /**
   * The MCP client used to execute generation tools in "Studio" mode.
   *
   * When present, the local model becomes the planner: it calls the MCP
   * server's tools and Helix drives the loop.
   */
  mcpClient?: McpClient;
  /** The tools the MCP server exposes, offered to the local model. */
  mcpTools?: Tool[];
  /** Maximum tool round trips per request. */
  maxAgentTurns?: number;
  now?: () => number;
}

export interface MessagesRequestContext {
  /** The presented API key. */
  apiKey: string | undefined;
  /** The `anthropic-version` header. */
  anthropicVersion?: string;
  body: unknown;
}

export type SseRecord = { event: string; data: string };

/** Build an SSE record from an Anthropic event. */
function toSseRecord(frame: AnthropicStreamEvent): SseRecord {
  return { event: frame.type, data: JSON.stringify(frame) };
}

export type MessagesResult =
  | {
      kind: "json";
      status: number;
      headers: Record<string, string>;
      message: AnthropicMessage;
    }
  | {
      kind: "stream";
      status: number;
      headers: Record<string, string>;
      frames: AsyncGenerator<SseRecord>;
    };

/** Headers Helix always attaches so provenance is never ambiguous. */
function provenanceHeaders(deployment: ModelDeployment | undefined): Record<string, string> {
  return {
    "x-helix-upstream-provider": deployment?.provider ?? "local",
    "x-helix-upstream-model": deployment?.model ?? "unknown",
  };
}

export async function handleMessages(
  deps: MessagesDeps,
  ctx: MessagesRequestContext,
): Promise<MessagesResult> {
  const reqId = `req_${Math.random().toString(36).slice(2, 26).padEnd(24, "0")}`;
  const now = deps.now ?? (() => Date.now());

  /* --------------------------------------------------------- auth */
  if (!ctx.apiKey) {
    throw authenticationError("Missing API key. Expected an Authorization header or x-api-key.", reqId);
  }
  const key = deps.keys.authenticate(ctx.apiKey);
  if (!key) {
    throw authenticationError("Invalid API key.", reqId);
  }
  if (!KeyStore.isActive(key, now())) {
    throw permissionDenied("This API key is expired or disabled.", reqId);
  }

  /* ------------------------------------------------------ validate */
  const group = (() => {
    const raw = (ctx.body as { model?: unknown } | null)?.model;
    if (typeof raw !== "string") return undefined;
    return deps.router.find(raw);
  })();
  if (!group) {
    const modelName = (ctx.body as { model?: unknown } | null)?.model;
    throw notFound(
      `model: ${JSON.stringify(modelName ?? null)} not found. Use GET /v1/models to list the available models.`,
      reqId,
    );
  }
  if (!KeyStore.allows(key, group.advertisedId)) {
    throw permissionDenied(
      `This API key is not permitted to use model ${group.advertisedId}.`,
      reqId,
    );
  }

  const spec = {
    id: group.advertisedId,
    line: group.line,
    maxInputTokens: group.maxInputTokens,
    maxOutputTokens: group.maxOutputTokens,
    defaultEffort: group.defaultEffort,
    allowedEfforts: group.allowedEfforts,
    thinkingTypes: ["adaptive"] as const,
    toolChoiceTypes: ["auto", "none"] as const,
    allowsSamplingParams: false,
    minCacheableTokens: 512,
  };

  let validated;
  try {
    validated = validateMessagesRequest(ctx.body, spec as never, {
      anthropicVersion: ctx.anthropicVersion,
      requestId: reqId,
    });
  } catch (err) {
    throw toAnthropicError(err, reqId);
  }
  const request: MessagesRequest = validated.request;

  /* ------------------------------------------------------- quota */
  const decision = await deps.quota.admit({
    subject: key.id,
    rateLimit: { rpm: key.rpm, windowSeconds: 60 },
  });
  if (!decision.allowed) {
    throw rateLimited(decision.message, reqId, {
      error_code: decision.reason === "rate_limit" ? "gateway_rpm_exceeded" : "gateway_spend_limit_reached",
    });
  }

  const headers: Record<string, string> = {
    "request-id": reqId,
    "content-type": "application/json",
    ...provenanceHeaders(undefined),
  };

  /* -------------------------------------------------- cache prewarm */
  if (validated.isCachePrewarm) {
    const message: AnthropicMessage = {
      id: newMessageId(),
      type: "message",
      role: "assistant",
      model: group.advertisedId,
      content: [],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { thinking_tokens: 0 },
        service_tier: "standard",
        speed: "standard",
        inference_geo: "global",
      },
    };
    return { kind: "json", status: 200, headers, message };
  }

  /* ---------------------------------------------------- deployment */
  const deployment = deps.router.select(group);
  if (!deployment) {
    throw upstreamError(
      "No healthy upstream is available for this model. Please retry shortly.",
      reqId,
    );
  }
  headers["x-helix-upstream-provider"] = deployment.provider;
  headers["x-helix-upstream-model"] = deployment.model;

  const features = deps.featuresFor?.(deployment) ?? {
    reasoningEffort: deployment.supportsReasoningEffort,
    jsonSchema: deployment.supportsJsonSchema,
    parallelToolCalls: true,
  };

  const openAiRequest = toOpenAiRequest(request, {
    model: deployment.model,
    features,
  });

  const client = deps.clientFor(deployment);
  const digest = conversationDigest(request);
  const thinkingEnabled = validated.effort !== "low";

  /**
   * The event source. In "Studio" mode the local model drives the MCP tools
   * itself; otherwise the upstream stream is passed straight through.
   */
  const eventSource = (): AsyncGenerator<import("@helix/local-adapter").IrEvent> => {
    if (deps.mcpClient && deps.mcpTools?.length) {
      return runAgent({
        request,
        model: deployment.model,
        stream: (openAiRequest) => client.stream(openAiRequest),
        mcp: deps.mcpClient,
        mcpTools: deps.mcpTools,
        features,
        ...(deps.maxAgentTurns ? { maxTurns: deps.maxAgentTurns } : {}),
      });
    }
    return client.stream(openAiRequest);
  };

  /* ------------------------------------------------------- stream */
  if (request.stream) {
    const assembler = new AnthropicStreamAssembler({
      model: group.advertisedId,
      messageId: newMessageId(),
      thinkingEnabled,
      signer: deps.signer,
      conversationDigest: digest,
    });

    const frames = (async function* () {
      for (const frame of assembler.start()) {
        yield toSseRecord(frame);
      }
      try {
        for await (const irEvent of eventSource()) {
          for (const frame of assembler.consume(irEvent)) {
            yield toSseRecord(frame);
          }
        }
        deps.router.recordSuccess(deployment.id);
      } catch (err) {
        deps.router.recordFailure(deployment.id);
        const anthropicError =
          err instanceof LocalModelUpstreamError ? err.anthropicType : "api_error";
        const message = err instanceof Error ? err.message : String(err);
        yield {
          event: "error",
          data: JSON.stringify({
            type: "error",
            error: { type: anthropicError, message },
          }),
        };
        return;
      }
      for (const frame of assembler.finish()) {
        yield toSseRecord(frame);
      }
    })();

    return {
      kind: "stream",
      status: 200,
      headers: { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" },
      frames,
    };
  }

  /* -------------------------------------------------- non-streaming */
  const assembler = new AnthropicStreamAssembler({
    model: group.advertisedId,
    messageId: newMessageId(),
    thinkingEnabled,
    signer: deps.signer,
    conversationDigest: digest,
  });

  try {
    // `start()` opens the leading thinking block and seeds the usage.
    for (const frame of assembler.start()) void frame;
    for await (const irEvent of eventSource()) {
      for (const frame of assembler.consume(irEvent)) void frame;
    }
    deps.router.recordSuccess(deployment.id);
  } catch (err) {
    deps.router.recordFailure(deployment.id);
    if (err instanceof LocalModelUpstreamError) {
      throw new AnthropicApiError({
        status: err.status >= 400 && err.status < 600 ? err.status : 500,
        type: err.anthropicType as never,
        message: `Local model upstream failed: ${err.message}`,
        requestId: reqId,
      });
    }
    throw toAnthropicError(err, reqId);
  }
  for (const frame of assembler.finish()) void frame;

  return { kind: "json", status: 200, headers, message: assembler.message };
}

export { invalidRequest };
