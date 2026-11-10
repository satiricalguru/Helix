/**
 * Anthropic Messages API wire types.
 *
 * Mirrors the shape documented at platform.claude.com/docs/en/api/messages.
 * Only the fields Helix actually reads, writes, or must validate are modelled;
 * unknown fields are preserved where round-tripping matters.
 */

export type AnthropicVersion = "2023-06-01" | "2026-10-21" | (string & {});

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded";

export type ContentBlockType =
  | "text"
  | "thinking"
  | "redacted_thinking"
  | "tool_use"
  | "tool_result"
  | "server_tool_use"
  | "image"
  | "document"
  | "search_result"
  | "container_upload";

/* ------------------------------------------------------------------ input */

export interface CacheControlEphemeral {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControlEphemeral | null;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: CacheControlEphemeral | null;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | unknown[];
  is_error?: boolean;
  cache_control?: CacheControlEphemeral | null;
}

export interface ImageBlock {
  type: "image";
  source:
    | { type: "base64"; data: string; media_type: string }
    | { type: "url"; url: string }
    | { type: "file"; file_id: string };
  cache_control?: CacheControlEphemeral | null;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | { type: string; [k: string]: unknown };

export interface MessageParam {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

export interface Tool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
  type?: "custom";
  strict?: boolean;
  cache_control?: CacheControlEphemeral | null;
}

export type ToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none"; disable_parallel_tool_use?: boolean };

export type ThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budget_tokens: number; display?: "summarized" | "omitted" }
  | { type: "disabled" }
  | { type: "between_tools" };

export interface OutputConfig {
  effort?: Effort;
  format?: { type: "json_schema"; schema: Record<string, unknown> };
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  system?: string | TextBlock[];
  stream?: boolean;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  thinking?: ThinkingConfig;
  output_config?: OutputConfig;
  metadata?: { user_id?: string };
  service_tier?: "auto" | "standard_only";
  speed?: "standard" | "fast";
  cache_control?: CacheControlEphemeral | null;
  [k: string]: unknown;
}

/* ----------------------------------------------------------------- output */

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  } | null;
  output_tokens: number;
  output_tokens_details?: { thinking_tokens: number } | null;
  server_tool_use?: { web_search_requests: number; web_fetch_requests: number } | null;
  service_tier?: "standard" | "priority" | "batch" | null;
  speed?: "standard" | "fast" | null;
  inference_geo?: string | null;
}

export interface StopDetails {
  type: "refusal";
  category?: string;
  explanation?: string;
}

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  stop_details?: StopDetails | null;
  diagnostics?: { cache_miss_reason?: { type: string; cache_missed_input_tokens?: number } } | null;
  usage: Usage;
}

/* --------------------------------------------------------------- streaming */

export type AnthropicStreamEvent =
  | { type: "message_start"; message: AnthropicMessage }
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | { type: "citations_delta"; citation: unknown };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason?: StopReason | null; stop_sequence?: string | null; stop_details?: StopDetails | null };
      usage?: Partial<Usage>;
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string; details?: unknown } };

/* --------------------------------------------------------------- models api */

export interface ModelInfo {
  id: string;
  display_name: string;
  created_at?: string;
  type?: "model";
  line?: "haiku" | "sonnet" | "opus" | "fable" | "mythos" | null;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: Record<string, unknown>;
  /** Helix extension: the real upstream that serves this alias. */
  backend?: string;
  /** Helix extension: human-readable provenance statement. */
  disclosure?: string;
}

export interface ModelsListResponse {
  data: ModelInfo[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}
