/**
 * HTTP surface of the gateway.
 *
 * Speaks the Anthropic Messages API closely enough that the official SDK and
 * Claude Code work against it unmodified.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  AnthropicApiError,
  toAnthropicError,
  type AnthropicMessage,
  type ModelsListResponse,
} from "@helix/contracts";
import { toModelSpec, type ModelGroup } from "@helix/config";
import { handleMessages, type MessagesDeps } from "./handler.js";

export interface AppOptions extends MessagesDeps {
  groups: ModelGroup[];
  /** Where unexpected errors are reported. Defaults to stderr. */
  logger?: { error: (message: string, error: unknown) => void };
}

function extractKey(authorization: string | undefined, xApiKey: string | undefined): string | undefined {
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1]!.trim();
    // Some clients send the raw key without a scheme.
    if (!authorization.includes(" ")) return authorization.trim();
  }
  return xApiKey?.trim() || undefined;
}

export function createApp(options: AppOptions) {
  const app = new Hono();

  app.onError((err, c) => {
    const anthropicError = toAnthropicError(err, `req_${c.req.header("x-request-id") ?? "unknown"}`);
    if (!(err instanceof AnthropicApiError)) {
      const logger = options.logger ?? {
        error: (message: string, error: unknown) => {
          console.error(message, error);
        },
      };
      logger.error(`[gateway] unhandled error on ${c.req.method} ${c.req.path}`, err);
    }
    const headers: Record<string, string> = {
      "request-id": anthropicError.requestId,
      "content-type": "application/json",
    };
    if (anthropicError.status === 429) {
      headers["retry-after"] = "60";
      headers["anthropic-ratelimit-requests-limit"] = "120";
      headers["anthropic-ratelimit-requests-remaining"] = "0";
      headers["anthropic-ratelimit-requests-reset"] = new Date(Date.now() + 60_000).toISOString();
    }
    return c.json(anthropicError.toBody(), anthropicError.status as never, headers);
  });

  /* --------------------------------------------------------- models */

  app.get("/v1/models", (c) => {
    const data = options.groups.map((g) => ({
      id: g.advertisedId,
      display_name: g.displayName,
      type: "model" as const,
      line: g.line,
      max_input_tokens: g.maxInputTokens,
      max_tokens: g.maxOutputTokens,
      capabilities: {
        thinking: { types: { adaptive: { supported: true } } },
        output_config: { effort: { supported: g.allowedEfforts } },
        tools: { supported: true },
      },
      backend: g.deployments.map((d) => `${d.provider}:${d.model}`).join(", "),
      disclosure: g.disclosure,
    }));
    const body: ModelsListResponse = {
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    };
    return c.json(body);
  });

  app.get("/v1/models/:id", (c) => {
    const group = options.router.find(c.req.param("id"));
    if (!group) {
      return c.json(
        {
          type: "error",
          error: { type: "not_found_error", message: `model ${c.req.param("id")} not found` },
          request_id: "req_unknown",
        },
        404,
      );
    }
    return c.json({
      id: group.advertisedId,
      display_name: group.displayName,
      type: "model",
      line: group.line,
      max_input_tokens: group.maxInputTokens,
      max_tokens: group.maxOutputTokens,
      backend: group.deployments.map((d) => `${d.provider}:${d.model}`).join(", "),
      disclosure: group.disclosure,
    });
  });

  /* -------------------------------------------------------- messages */

  app.post("/v1/messages", async (c) => {
    const apiKey = extractKey(c.req.header("authorization"), c.req.header("x-api-key"));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AnthropicApiError({
        status: 400,
        type: "invalid_request_error",
        message: "Request body must be valid JSON.",
        requestId: "req_invalid_json",
      });
    }

    const result = await handleMessages(options, {
      apiKey,
      anthropicVersion: c.req.header("anthropic-version"),
      body,
    });

    if (result.kind === "json") {
      return c.json(result.message as AnthropicMessage, result.status as never, result.headers);
    }

    return streamSSE(c, async (stream) => {
      for await (const frame of result.frames) {
        await stream.writeSSE(frame);
      }
    });
  });

  /* ----------------------------------------------------- count tokens */

  app.post("/v1/messages/count_tokens", async (c) => {
    const apiKey = extractKey(c.req.header("authorization"), c.req.header("x-api-key"));
    if (!apiKey || !options.keys.authenticate(apiKey)) {
      return c.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "Invalid API key." },
          request_id: "req_unknown",
        },
        401,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      model?: string;
      messages?: unknown;
      system?: unknown;
      tools?: unknown;
    };
    const group = body.model ? options.router.find(body.model) : undefined;
    if (!group) {
      return c.json(
        {
          type: "error",
          error: { type: "not_found_error", message: "model not found" },
          request_id: "req_unknown",
        },
        404,
      );
    }
    // A rough estimate: ~4 characters per token, which is close enough for a
    // pre-flight budget check.
    const text = JSON.stringify({
      messages: body.messages ?? [],
      system: body.system ?? null,
      tools: body.tools ?? [],
    });
    const inputTokens = Math.ceil(text.length / 4);
    return c.json({ input_tokens: inputTokens });
  });

  /* ----------------------------------------------------------- health */

  app.get("/health/live", (c) => c.json({ status: "ok" }));

  app.get("/health/ready", (c) =>
    c.json({
      status: "ok",
      models: options.groups.map((g) => g.advertisedId),
    }),
  );

  return app;
}

export { toModelSpec };
