/**
 * Fable 5.2 request validation.
 *
 * Reproduces the 400s that the real `claude-fable-5-2` endpoint returns, so a
 * client that talks to Helix sees the same contract it would see upstream.
 * Error messages are deliberately close to Anthropic's own wording.
 */

import { AnthropicApiError, invalidRequest } from "./errors.js";
import type {
  ContentBlock,
  MessageParam,
  MessagesRequest,
  Tool,
  ToolChoice,
} from "./types.js";

/** Behavioural spec for a model served by Helix. */
export interface ModelSpec {
  id: string;
  line: "haiku" | "sonnet" | "opus" | "fable" | "mythos";
  maxInputTokens: number;
  maxOutputTokens: number;
  defaultEffort: "low" | "medium" | "high" | "xhigh" | "max";
  allowedEfforts: readonly ("low" | "medium" | "high" | "xhigh" | "max")[];
  /** `thinking.type` values the model accepts. */
  thinkingTypes: readonly ("adaptive" | "enabled" | "disabled" | "between_tools")[];
  /** `tool_choice` types the model accepts. */
  toolChoiceTypes: readonly ("auto" | "any" | "tool" | "none")[];
  /** Whether `temperature`/`top_p`/`top_k` are accepted at all. */
  allowsSamplingParams: boolean;
  minCacheableTokens: number;
}

export const FABLE_5_2: ModelSpec = {
  id: "claude-fable-5-2",
  line: "fable",
  maxInputTokens: 1_000_000,
  maxOutputTokens: 131_072,
  defaultEffort: "high",
  allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
  thinkingTypes: ["adaptive"],
  toolChoiceTypes: ["auto", "none"],
  allowsSamplingParams: false,
  minCacheableTokens: 512,
};

const LATEST_VERSION = "2026-10-21";
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_MESSAGES = 100_000;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** True when the request targets the `2026-10-21` (or newer) API version. */
export function isLatestApiVersion(version: string | undefined): boolean {
  if (!version) return false;
  return version >= LATEST_VERSION;
}

export interface ValidationResult {
  request: MessagesRequest;
  /** `thinking` blocks the caller echoed back, keyed by message index. */
  thinkingBlocks: Array<{ messageIndex: number; blockIndex: number; signature: string; thinking: string }>;
  /** Whether `max_tokens === 0` (cache prewarm, no generation). */
  isCachePrewarm: boolean;
  /** Effort resolved from the request or the model default. */
  effort: ModelSpec["defaultEffort"];
}

export function validateMessagesRequest(
  body: unknown,
  spec: ModelSpec,
  options: { anthropicVersion?: string; requestId: string },
): ValidationResult {
  const { requestId } = options;
  const version = options.anthropicVersion;

  if (!isPlainObject(body)) {
    throw invalidRequest("Request body must be a JSON object.", requestId);
  }

  /* ------------------------------------------------------------- model */
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw invalidRequest("messages: Field required: `model`.", requestId);
  }

  /* --------------------------------------------------------- max_tokens */
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens)) {
    throw invalidRequest("max_tokens: Field required.", requestId);
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 0) {
    throw invalidRequest(
      "max_tokens: Input should be greater than or equal to 0.",
      requestId,
    );
  }
  if (maxTokens > spec.maxOutputTokens) {
    throw invalidRequest(
      `max_tokens: Input should be less than or equal to ${spec.maxOutputTokens}.`,
      requestId,
    );
  }

  /* ----------------------------------------------------------- messages */
  if (!Array.isArray(body.messages)) {
    throw invalidRequest("messages: Field required.", requestId);
  }
  if (body.messages.length === 0) {
    throw invalidRequest("messages: Input should have at least 1 item.", requestId);
  }
  if (body.messages.length > MAX_MESSAGES) {
    throw invalidRequest(
      `messages: List should have at most ${MAX_MESSAGES} items.`,
      requestId,
    );
  }

  const messages: MessageParam[] = [];
  const thinkingBlocks: ValidationResult["thinkingBlocks"] = [];

  body.messages.forEach((raw, messageIndex) => {
    if (!isPlainObject(raw)) {
      throw invalidRequest(`messages.${messageIndex}: Input should be a valid dictionary.`, requestId);
    }
    const role = raw.role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw invalidRequest(
        `messages.${messageIndex}.role: Input should be 'user', 'assistant' or 'system'.`,
        requestId,
      );
    }
    const content = raw.content;
    if (typeof content !== "string" && !Array.isArray(content)) {
      throw invalidRequest(
        `messages.${messageIndex}.content: Input should be a valid string or list.`,
        requestId,
      );
    }
    if (Array.isArray(content)) {
      content.forEach((block, blockIndex) => {
        validateContentBlock(block, `messages.${messageIndex}.content.${blockIndex}`, requestId);
        if (isPlainObject(block) && block.type === "thinking") {
          thinkingBlocks.push({
            messageIndex,
            blockIndex,
            signature: typeof block.signature === "string" ? block.signature : "",
            thinking: typeof block.thinking === "string" ? block.thinking : "",
          });
        }
      });
    }
    messages.push({ role, content } as MessageParam);
  });

  // Prefill: Fable 5.2 does not support assistant prefill.
  const last = messages[messages.length - 1]!;
  if (last.role === "assistant") {
    throw invalidRequest(
      "This model does not support assistant message prefill. The conversation must end with a user message.",
      requestId,
    );
  }
  if (last.role === "system") {
    throw invalidRequest(
      `messages: The last message must use the "user" role.`,
      requestId,
    );
  }

  /* -------------------------------------------------- sampling params */
  if (!spec.allowsSamplingParams) {
    const latest = isLatestApiVersion(version);
    const offenders: string[] = [];
    if (body.temperature !== undefined) {
      // Default temperature is 1; anything else is rejected.
      if (latest || body.temperature !== 1) offenders.push("temperature");
    }
    if (body.top_p !== undefined) {
      if (latest || body.top_p !== 1) offenders.push("top_p");
    }
    if (body.top_k !== undefined) {
      offenders.push("top_k");
    }
    if (offenders.length > 0) {
      throw invalidRequest(
        `${offenders.join(", ")}: Input should be omitted for this model. See https://platform.claude.com/docs/en/build-with-claude/thinking#sampling-parameters for the values that return a 400 error.`,
        requestId,
      );
    }
  }

  /* ----------------------------------------------------------- thinking */
  if (body.thinking !== undefined) {
    if (!isPlainObject(body.thinking)) {
      throw invalidRequest("thinking: Input should be a valid dictionary.", requestId);
    }
    const type = body.thinking.type;
    if (typeof type !== "string") {
      throw invalidRequest("thinking.type: Field required.", requestId);
    }
    if (!spec.thinkingTypes.includes(type as never)) {
      if (type === "enabled") {
        throw invalidRequest(
          '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking depth.',
          requestId,
        );
      }
      if (type === "disabled") {
        throw invalidRequest(
          '"thinking.type.disabled" is not supported for this model.',
          requestId,
        );
      }
      throw invalidRequest(
        `"thinking.type.${type}" is not supported for this model.`,
        requestId,
      );
    }
    if (type === "adaptive" && body.thinking.budget_tokens !== undefined) {
      throw invalidRequest(
        "thinking.budget_tokens: Extra inputs are not permitted",
        requestId,
      );
    }
  }

  /* ------------------------------------------------------- tool_choice */
  let toolChoice: ToolChoice | undefined;
  if (body.tool_choice !== undefined) {
    if (!isPlainObject(body.tool_choice)) {
      throw invalidRequest("tool_choice: Input should be a valid dictionary.", requestId);
    }
    const type = body.tool_choice.type;
    if (typeof type !== "string") {
      throw invalidRequest("tool_choice.type: Field required.", requestId);
    }
    if (!spec.toolChoiceTypes.includes(type as never)) {
      if (type === "any" || type === "tool") {
        throw invalidRequest(
          'tool_choice: type "tool" and "any" are not supported for this model.',
          requestId,
        );
      }
      throw invalidRequest(`"tool_choice.type.${type}" is not supported for this model.`, requestId);
    }
    toolChoice = body.tool_choice as ToolChoice;
  }

  /* ------------------------------------------------------------- tools */
  let tools: Tool[] | undefined;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      throw invalidRequest("tools: Input should be a valid list.", requestId);
    }
    tools = body.tools.map((raw, i) => {
      if (!isPlainObject(raw)) {
        throw invalidRequest(`tools.${i}: Input should be a valid dictionary.`, requestId);
      }
      const name = raw.name;
      if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) {
        throw invalidRequest(
          `tools.${i}.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'.`,
          requestId,
        );
      }
      if (!isPlainObject(raw.input_schema)) {
        throw invalidRequest(`tools.${i}.input_schema: Field required.`, requestId);
      }
      return raw as unknown as Tool;
    });
  }

  /* ----------------------------------------------------- output_config */
  let effort: ModelSpec["defaultEffort"] = spec.defaultEffort;
  if (body.output_config !== undefined) {
    if (!isPlainObject(body.output_config)) {
      throw invalidRequest("output_config: Input should be a valid dictionary.", requestId);
    }
    if (body.output_config.effort !== undefined) {
      const e = body.output_config.effort;
      if (typeof e !== "string" || !spec.allowedEfforts.includes(e as never)) {
        throw invalidRequest(
          `output_config.effort: Input should be ${spec.allowedEfforts
            .map((x) => `'${x}'`)
            .join(" | ")}.`,
          requestId,
        );
      }
      effort = e as ModelSpec["defaultEffort"];
    }
    if (body.output_config.format !== undefined) {
      if (!isPlainObject(body.output_config.format)) {
        throw invalidRequest("output_config.format: Input should be a valid dictionary.", requestId);
      }
      if (body.output_config.format.type !== "json_schema") {
        throw invalidRequest(
          "output_config.format.type: Input should be 'json_schema'.",
          requestId,
        );
      }
      if (!isPlainObject(body.output_config.format.schema)) {
        throw invalidRequest("output_config.format.schema: Field required.", requestId);
      }
    }
  }

  /* ------------------------------------------------------------ system */
  if (body.system !== undefined) {
    if (typeof body.system === "string") {
      // ok
    } else if (Array.isArray(body.system)) {
      body.system.forEach((block, i) => {
        if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
          throw invalidRequest(
            `system.${i}: Input should be a valid text block.`,
            requestId,
          );
        }
      });
    } else {
      throw invalidRequest(
        "system: Input should be a valid string or list.",
        requestId,
      );
    }
  }

  /* -------------------------------------------------------- misc fields */
  if (body.stop_sequences !== undefined) {
    if (
      !Array.isArray(body.stop_sequences) ||
      body.stop_sequences.some((s) => typeof s !== "string")
    ) {
      throw invalidRequest("stop_sequences: Input should be a valid list of strings.", requestId);
    }
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalidRequest("stream: Input should be a valid boolean.", requestId);
  }
  if (body.metadata !== undefined) {
    if (!isPlainObject(body.metadata)) {
      throw invalidRequest("metadata: Input should be a valid dictionary.", requestId);
    }
    if (body.metadata.user_id !== undefined) {
      if (typeof body.metadata.user_id !== "string") {
        throw invalidRequest("metadata.user_id: Input should be a valid string.", requestId);
      }
      if (body.metadata.user_id.length > 512) {
        throw invalidRequest(
          "metadata.user_id: String should have at most 512 characters.",
          requestId,
        );
      }
    }
  }
  if (body.speed !== undefined && body.speed !== "standard" && body.speed !== "fast") {
    throw invalidRequest("speed: Input should be 'standard' or 'fast'.", requestId);
  }
  if (
    body.service_tier !== undefined &&
    body.service_tier !== "auto" &&
    body.service_tier !== "standard_only"
  ) {
    throw invalidRequest("service_tier: Input should be 'auto' or 'standard_only'.", requestId);
  }

  const request: MessagesRequest = {
    ...(body as Record<string, unknown>),
    model: body.model,
    max_tokens: maxTokens,
    messages,
  } as MessagesRequest;
  if (tools) request.tools = tools;
  if (toolChoice) request.tool_choice = toolChoice;

  return {
    request,
    thinkingBlocks,
    isCachePrewarm: maxTokens === 0,
    effort,
  };
}

function validateContentBlock(block: unknown, path: string, requestId: string): void {
  if (!isPlainObject(block)) {
    throw invalidRequest(`${path}: Input should be a valid dictionary.`, requestId);
  }
  const type = block.type;
  if (typeof type !== "string") {
    throw invalidRequest(`${path}.type: Field required.`, requestId);
  }
  switch (type) {
    case "text":
      if (typeof block.text !== "string") {
        throw invalidRequest(`${path}.text: Input should be a valid string.`, requestId);
      }
      break;
    case "thinking":
      if (typeof block.thinking !== "string" || typeof block.signature !== "string") {
        throw invalidRequest(
          `${path}: thinking and signature are required for a thinking block.`,
          requestId,
        );
      }
      break;
    case "redacted_thinking":
      if (typeof block.data !== "string") {
        throw invalidRequest(`${path}.data: Field required.`, requestId);
      }
      break;
    case "tool_use":
      if (typeof block.id !== "string" || typeof block.name !== "string") {
        throw invalidRequest(`${path}: id and name are required for a tool_use block.`, requestId);
      }
      break;
    case "tool_result":
      if (typeof block.tool_use_id !== "string") {
        throw invalidRequest(`${path}.tool_use_id: Field required.`, requestId);
      }
      break;
    case "image":
      if (!isPlainObject(block.source)) {
        throw invalidRequest(`${path}.source: Field required.`, requestId);
      }
      break;
    default:
      // Unknown block types are tolerated; Anthropic adds new ones over time.
      break;
  }
}

export { AnthropicApiError };
export type { ContentBlock };
