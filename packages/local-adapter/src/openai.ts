/**
 * OpenAI-compatible chat-completions types and Anthropic -> OpenAI request
 * mapping.
 *
 * "OpenAI-compatible" is the lingua franca of local model servers (Ollama,
 * llama.cpp, vLLM, LM Studio, TGI), so Helix speaks it rather than any one
 * vendor's dialect.
 */

import type { MessagesRequest, Tool } from "@helix/contracts";

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiMessage[];
  max_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: OpenAiTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  stop?: string[];
  temperature?: number;
  top_p?: number;
  user?: string;
  /** Non-standard but widely supported reasoning knob. */
  reasoning_effort?: "low" | "medium" | "high";
  /** OpenAI-style structured output. */
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
  };
}

/** Servers that expose `reasoning_effort` and structured output. */
export interface LocalModelFeatures {
  reasoningEffort: boolean;
  jsonSchema: boolean;
  parallelToolCalls: boolean;
}

export const DEFAULT_FEATURES: LocalModelFeatures = {
  reasoningEffort: false,
  jsonSchema: false,
  parallelToolCalls: true,
};

/**
 * Convert an Anthropic Messages request into an OpenAI chat request.
 *
 * Notable translations:
 *  - `system` becomes a leading system message.
 *  - assistant `tool_use` blocks become `tool_calls`.
 *  - user `tool_result` blocks become `role: "tool"` messages.
 *  - `output_config.effort` becomes `reasoning_effort` (clamped: xhigh/max -> high).
 *  - `output_config.format` becomes `response_format` when supported.
 */
export function toOpenAiRequest(
  request: MessagesRequest,
  opts: {
    model: string;
    features?: LocalModelFeatures;
    /** Anthropic tool names mapped back to upstream names (see tool-name map). */
    toolNameMap?: Map<string, string>;
  },
): OpenAiChatRequest {
  const features = opts.features ?? DEFAULT_FEATURES;
  const messages: OpenAiMessage[] = [];

  if (request.system !== undefined) {
    const text =
      typeof request.system === "string"
        ? request.system
        : request.system.map((b) => ("text" in b ? b.text : "")).join("\n");
    if (text.trim() !== "") messages.push({ role: "system", content: text });
  }

  for (const message of request.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role === "system" ? "system" : message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    const textParts: string[] = [];
    const toolCalls: OpenAiMessage["tool_calls"] = [];
    const toolResults: OpenAiMessage[] = [];

    for (const block of message.content) {
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case "text":
          if (typeof b.text === "string") textParts.push(b.text);
          break;
        case "tool_use": {
          const name =
            typeof b.name === "string"
              ? (opts.toolNameMap?.get(b.name) ?? b.name)
              : String(b.name);
          toolCalls.push({
            id: String(b.id ?? ""),
            type: "function",
            function: { name, arguments: JSON.stringify(b.input ?? {}) },
          });
          break;
        }
        case "tool_result": {
          const content = b.content;
          let text = "";
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            text = content
              .map((c) => {
                const cc = c as Record<string, unknown>;
                return typeof cc.text === "string" ? cc.text : "";
              })
              .filter(Boolean)
              .join("\n");
          }
          toolResults.push({
            role: "tool",
            tool_call_id: String(b.tool_use_id ?? ""),
            content: text,
          });
          break;
        }
        case "thinking":
        case "redacted_thinking":
          // Reasoning is not forwarded to the upstream model verbatim; Helix
          // keeps it for its own continuity and re-derives context from the
          // conversation instead.
          break;
        default:
          break;
      }
    }

    // Tool results must come before the text of the turn that carries them.
    messages.push(...toolResults);

    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : null,
        tool_calls: toolCalls,
      });
    } else if (textParts.length > 0) {
      messages.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: textParts.join("\n"),
      });
    }
  }

  const out: OpenAiChatRequest = {
    model: opts.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (request.max_tokens > 0) out.max_tokens = request.max_tokens;
  if (request.stop_sequences?.length) out.stop = request.stop_sequences;
  if (request.metadata?.user_id) out.user = request.metadata.user_id;

  if (request.tools?.length) {
    out.tools = request.tools.map((tool: Tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema as Record<string, unknown>,
      },
    }));
  }

  if (request.tool_choice) {
    if (request.tool_choice.type === "auto") out.tool_choice = "auto";
    else if (request.tool_choice.type === "none") out.tool_choice = "none";
  }

  if (features.reasoningEffort && request.output_config?.effort) {
    const effort = request.output_config.effort;
    out.reasoning_effort = effort === "xhigh" || effort === "max" ? "high" : effort;
  }

  if (features.jsonSchema && request.output_config?.format?.type === "json_schema") {
    out.response_format = {
      type: "json_schema",
      json_schema: {
        name: "structured_output",
        schema: request.output_config.format.schema,
        strict: true,
      },
    };
  }

  return out;
}
