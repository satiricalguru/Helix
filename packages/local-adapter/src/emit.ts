/**
 * IR -> Anthropic Messages stream.
 *
 * Produces the exact event sequence Anthropic clients expect:
 *
 *   message_start
 *   (content_block_start content_block_delta* content_block_stop)*
 *   message_delta
 *   message_stop
 *
 * and assembles the equivalent final Message object so the non-streaming path
 * can reuse the same machinery.
 */

import type {
  AnthropicMessage,
  AnthropicStreamEvent,
  ContentBlock,
  StopReason,
  Usage,
} from "@helix/contracts";
import { EMPTY_USAGE, type IrEvent, type IrUsage } from "./ir.js";
import { ThinkingSigner } from "./signature.js";

export interface AssemblerOptions {
  /** The advertised model id echoed back to the client. */
  model: string;
  messageId: string;
  /** When true a thinking block is opened up-front (Fable's always-on thinking). */
  thinkingEnabled: boolean;
  /** Used to sign the thinking block. */
  signer: ThinkingSigner;
  /** Binds the signature to this conversation. */
  conversationDigest: string;
}

interface OpenBlock {
  index: number;
  type: "text" | "thinking" | "tool_use";
  text: string;
  toolId?: string;
  toolName?: string;
  toolJson?: string;
}

export class AnthropicStreamAssembler {
  #opts: AssemblerOptions;
  #blocks: ContentBlock[] = [];
  #open: OpenBlock | null = null;
  #nextIndex = 0;
  #usage: IrUsage = { ...EMPTY_USAGE };
  #stopReason: StopReason | null = null;
  #stopSequence: string | null = null;
  #started = false;
  #finished = false;
  #errored = false;

  constructor(opts: AssemblerOptions) {
    this.#opts = opts;
  }

  get usage(): IrUsage {
    return this.#usage;
  }

  /**
   * Emit `message_start` and open the leading thinking block.
   *
   * Returns an array because Fable's always-on thinking means a
   * `content_block_start` for the thinking block immediately follows
   * `message_start`.
   */
  start(): AnthropicStreamEvent[] {
    if (this.#started) {
      throw new Error("AnthropicStreamAssembler.start() called twice");
    }
    this.#started = true;

    const message: AnthropicMessage = {
      id: this.#opts.messageId,
      type: "message",
      role: "assistant",
      model: this.#opts.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: this.#anthropicUsage(),
    };

    const frames: AnthropicStreamEvent[] = [{ type: "message_start", message }];

    if (this.#opts.thinkingEnabled) {
      const { frames: blockFrames } = this.#openBlock("thinking");
      frames.push(...blockFrames);
    }
    return frames;
  }

  /** Feed one IR event; returns the frames to write (possibly empty). */
  consume(event: IrEvent): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = [];
    switch (event.kind) {
      case "text": {
        if (!event.text) break;
        const { block, frames } = this.#ensureTextBlock();
        out.push(...frames);
        block.text += event.text;
        out.push({
          type: "content_block_delta",
          index: block.index,
          delta: { type: "text_delta", text: event.text },
        });
        break;
      }
      case "thinking": {
        if (!event.text) break;
        // A disabled-thinking model must not emit thinking blocks.
        if (!this.#opts.thinkingEnabled) break;
        const { block, frames } = this.#ensureThinkingBlock();
        out.push(...frames);
        block.text += event.text;
        out.push({
          type: "content_block_delta",
          index: block.index,
          delta: { type: "thinking_delta", thinking: event.text },
        });
        break;
      }
      case "tool_start": {
        out.push(...this.#closeOpenBlock());
        const index = this.#nextIndex++;
        this.#open = {
          index,
          type: "tool_use",
          text: "",
          toolId: event.id,
          toolName: event.name,
          toolJson: "",
        };
        out.push({
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
        });
        break;
      }
      case "tool_args": {
        if (!this.#open || this.#open.type !== "tool_use") break;
        this.#open.toolJson = (this.#open.toolJson ?? "") + event.partialJson;
        out.push({
          type: "content_block_delta",
          index: this.#open.index,
          delta: { type: "input_json_delta", partial_json: event.partialJson },
        });
        break;
      }
      case "tool_end": {
        out.push(...this.#closeOpenBlock());
        break;
      }
      case "usage": {
        // Usage is cumulative; later values replace earlier ones.
        this.#usage = event.usage;
        break;
      }
      case "finish": {
        this.#stopReason = event.stopReason;
        this.#stopSequence = event.stopSequence;
        break;
      }
      case "ping": {
        out.push({ type: "ping" });
        break;
      }
      case "error": {
        this.#errored = true;
        out.push({ type: "error", error: event.error });
        break;
      }
    }
    return out;
  }

  /** Close open blocks and emit `message_delta` + `message_stop`. */
  finish(): AnthropicStreamEvent[] {
    if (this.#finished) return [];
    this.#finished = true;
    const out: AnthropicStreamEvent[] = [...this.#closeOpenBlock()];

    const usage = this.#anthropicUsage();
    const delta: {
      stop_reason?: StopReason | null;
      stop_sequence?: string | null;
    } = {
      stop_reason: this.#stopReason,
      stop_sequence: this.#stopSequence,
    };

    out.push({
      type: "message_delta",
      delta,
      usage: {
        output_tokens: usage.output_tokens,
        input_tokens: usage.input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        ...(usage.output_tokens_details ? { output_tokens_details: usage.output_tokens_details } : {}),
      },
    });
    out.push({ type: "message_stop" });
    return out;
  }

  /** The assembled final message. */
  get message(): AnthropicMessage {
    return {
      id: this.#opts.messageId,
      type: "message",
      role: "assistant",
      model: this.#opts.model,
      content: this.#blocks,
      stop_reason: this.#stopReason,
      stop_sequence: this.#stopSequence,
      usage: this.#anthropicUsage(),
    };
  }

  get errored(): boolean {
    return this.#errored;
  }

  /* ------------------------------------------------------------ internals */

  #openBlock(type: OpenBlock["type"]): { block: OpenBlock; frames: AnthropicStreamEvent[] } {
    const index = this.#nextIndex++;
    const block: OpenBlock = { index, type, text: "" };
    this.#open = block;
    const frames: AnthropicStreamEvent[] = [];
    if (type === "text") {
      frames.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    } else if (type === "thinking") {
      frames.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
    }
    return { block, frames };
  }

  #ensureTextBlock(): { block: OpenBlock; frames: AnthropicStreamEvent[] } {
    if (this.#open && this.#open.type === "text") {
      return { block: this.#open, frames: [] };
    }
    // A text block always gets its own index, so close whatever is open.
    const closing = this.#closeOpenBlock();
    const { block, frames } = this.#openBlock("text");
    return { block, frames: [...closing, ...frames] };
  }

  #ensureThinkingBlock(): { block: OpenBlock; frames: AnthropicStreamEvent[] } {
    if (this.#open && this.#open.type === "thinking") {
      return { block: this.#open, frames: [] };
    }
    const closing = this.#closeOpenBlock();
    const { block, frames } = this.#openBlock("thinking");
    return { block, frames: [...closing, ...frames] };
  }

  #closeOpenBlock(): AnthropicStreamEvent[] {
    const open = this.#open;
    if (!open) return [];
    this.#open = null;
    const out: AnthropicStreamEvent[] = [];

    if (open.type === "text") {
      this.#blocks.push({ type: "text", text: open.text });
    } else if (open.type === "thinking") {
      const signature = this.#opts.signer.mint(
        this.#opts.conversationDigest,
        open.index,
        open.text,
      );
      out.push({
        type: "content_block_delta",
        index: open.index,
        delta: { type: "signature_delta", signature },
      });
      this.#blocks.push({ type: "thinking", thinking: open.text, signature });
    } else {
      let input: unknown = {};
      const raw = open.toolJson ?? "";
      if (raw.trim() !== "") {
        try {
          input = JSON.parse(raw);
        } catch {
          // Malformed tool arguments: surface an empty object rather than
          // crashing the stream. The client sees a tool_use with no input.
          input = {};
        }
      }
      this.#blocks.push({
        type: "tool_use",
        id: open.toolId ?? "",
        name: open.toolName ?? "",
        input,
      });
    }

    out.push({ type: "content_block_stop", index: open.index });
    return out;
  }

  #anthropicUsage(): Usage {
    const u = this.#usage;
    return {
      input_tokens: u.inputTokens,
      cache_creation_input_tokens: u.cacheCreationTokens,
      cache_read_input_tokens: u.cacheReadTokens,
      cache_creation: {
        ephemeral_5m_input_tokens: u.cacheCreationTokens,
        ephemeral_1h_input_tokens: 0,
      },
      output_tokens: u.outputTokens,
      output_tokens_details: { thinking_tokens: u.thinkingTokens },
      server_tool_use: null,
      service_tier: "standard",
      speed: "standard",
      inference_geo: "global",
    };
  }
}
