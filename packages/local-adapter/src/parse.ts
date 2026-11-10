/**
 * OpenAI-compatible stream chunk -> IR events.
 *
 * Handles the shapes emitted by Ollama, llama.cpp, vLLM, LM Studio and
 * TGI, which differ in where they put the usage block and whether they
 * expose reasoning tokens.
 */

import type { StopReason } from "@helix/contracts";
import { EMPTY_USAGE, type IrEvent, type IrUsage } from "./ir.js";

export interface OpenAiChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    case "stop":
    case null:
    case undefined:
    default:
      return "end_turn";
  }
}

/**
 * Convert one OpenAI chunk into zero or more IR events.
 *
 * Tool calls are tracked so that the first fragment of a tool call emits a
 * `tool_start` (carrying the id and name) and later fragments emit
 * `tool_args` for the same index.
 */
export class OpenAiChunkParser {
  #startedTools = new Set<number>();
  #usage: IrUsage = { ...EMPTY_USAGE };
  #sawFinish = false;

  parse(chunk: OpenAiChunk): IrEvent[] {
    const events: IrEvent[] = [];

    if (chunk.usage) {
      const promptTokens = chunk.usage.prompt_tokens ?? 0;
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      this.#usage = {
        // Anthropic semantics: input_tokens counts only tokens after the
        // cache breakpoint, so subtract the cached portion.
        inputTokens: Math.max(0, promptTokens - cached),
        cacheReadTokens: cached,
        cacheCreationTokens: 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        thinkingTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
      };
      events.push({ kind: "usage", usage: this.#usage });
    }

    const choice = chunk.choices?.[0];
    if (!choice) return events;

    const delta = choice.delta;

    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      events.push({ kind: "thinking", text: reasoning });
    }

    if (typeof delta?.content === "string" && delta.content.length > 0) {
      events.push({ kind: "text", text: delta.content });
    }

    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? 0;
      if (!this.#startedTools.has(index)) {
        this.#startedTools.add(index);
        events.push({
          kind: "tool_start",
          index,
          id: tc.id ?? `call_${index}`,
          name: tc.function?.name ?? "",
        });
      }
      const args = tc.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        events.push({ kind: "tool_args", index, partialJson: args });
      }
    }

    if (choice.finish_reason) {
      this.#sawFinish = true;
      for (const index of this.#startedTools) {
        events.push({ kind: "tool_end", index });
      }
      events.push({
        kind: "finish",
        stopReason: mapFinishReason(choice.finish_reason),
        stopSequence: null,
      });
    }

    return events;
  }

  get usage(): IrUsage {
    return this.#usage;
  }

  get sawFinish(): boolean {
    return this.#sawFinish;
  }

  /**
   * Called when the upstream stream ends.
   *
   * Some servers close the connection without sending a `finish_reason`; in
   * that case the turn is treated as a normal completion rather than being
   * left with a null `stop_reason`.
   */
  finalize(): IrEvent[] {
    if (this.#sawFinish) return [];
    this.#sawFinish = true;
    const events: IrEvent[] = [];
    for (const index of this.#startedTools) {
      events.push({ kind: "tool_end", index });
    }
    events.push({ kind: "finish", stopReason: "end_turn", stopSequence: null });
    return events;
  }
}

/** Map an upstream HTTP status onto an Anthropic error type. */
export function upstreamErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status === 504) return "timeout_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}
