/**
 * Normalised intermediate representation for model streams.
 *
 * Every upstream format is parsed into this shape and every downstream format
 * is emitted from it, so adding a provider costs one parser and one emitter
 * rather than an N x M matrix of translators.
 */

import type { StopReason } from "@helix/contracts";

export type IrEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_start"; index: number; id: string; name: string }
  | { kind: "tool_args"; index: number; partialJson: string }
  | { kind: "tool_end"; index: number }
  | { kind: "usage"; usage: IrUsage }
  | { kind: "finish"; stopReason: StopReason; stopSequence: string | null }
  | { kind: "ping" }
  | { kind: "error"; error: { type: string; message: string } };

export interface IrUsage {
  /** Prompt tokens billed after the cache breakpoint (Anthropic semantics). */
  inputTokens: number;
  /** Prompt tokens served from cache. */
  cacheReadTokens: number;
  /** Prompt tokens written to cache. */
  cacheCreationTokens: number;
  outputTokens: number;
  /** Reasoning tokens, if the upstream reports them. */
  thinkingTokens: number;
}

export const EMPTY_USAGE: IrUsage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
};
