/**
 * Client for an OpenAI-compatible local model server.
 *
 * Speaks the `/v1/chat/completions` streaming endpoint and yields IR events.
 * Works with Ollama, llama.cpp's `llama-server`, vLLM, LM Studio and TGI.
 */

import { readSse } from "@helix/contracts";
import type { IrEvent } from "./ir.js";
import { OpenAiChunkParser, upstreamErrorType, type OpenAiChunk } from "./parse.js";
import type { OpenAiChatRequest } from "./openai.js";

export interface LocalModelClientOptions {
  /** e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Extra headers (e.g. an auth token for a hosted local server). */
  headers?: Record<string, string>;
  /**
   * The context window to request.
   *
   * Ollama defaults to 4096 tokens regardless of the model's capability, which
   * is easily exceeded by a handful of tool schemas.
   */
  numCtx?: number;
  /** Abort the upstream request after this many ms. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class LocalModelUpstreamError extends Error {
  readonly status: number;
  readonly anthropicType: string;
  readonly body: string;

  constructor(opts: { status: number; body: string; message?: string }) {
    super(opts.message ?? `Local model server returned ${opts.status}`);
    this.name = "LocalModelUpstreamError";
    this.status = opts.status;
    this.body = opts.body;
    this.anthropicType = upstreamErrorType(opts.status);
  }
}

export class LocalModelClient {
  #opts: LocalModelClientOptions;
  #fetch: typeof fetch;

  constructor(opts: LocalModelClientOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  get model(): string {
    return this.#opts.model;
  }

  /** Stream IR events for a chat request. */
  async *stream(request: OpenAiChatRequest): AsyncGenerator<IrEvent> {
    const url = `${this.#opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(this.#opts.headers ?? {}),
    };
    if (this.#opts.apiKey) headers.authorization = `Bearer ${this.#opts.apiKey}`;

    const controller = new AbortController();
    const timeout = this.#opts.timeoutMs
      ? setTimeout(() => controller.abort(), this.#opts.timeoutMs)
      : undefined;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(
          this.#opts.numCtx
            ? { ...request, options: { num_ctx: this.#opts.numCtx } }
            : request,
        ),
        signal: controller.signal,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LocalModelUpstreamError({ status: response.status, body });
    }
    if (!response.body) {
      throw new LocalModelUpstreamError({
        status: 502,
        body: "",
        message: "Local model server returned an empty body",
      });
    }

    const parser = new OpenAiChunkParser();
    for await (const record of readSse(response.body as unknown as AsyncIterable<Uint8Array>)) {
      const payload = record.data.trim();
      if (payload === "" || payload === "[DONE]") continue;
      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(payload) as OpenAiChunk;
      } catch {
        // A malformed frame should not kill the stream.
        continue;
      }
      for (const event of parser.parse(chunk)) yield event;
    }

    // The stream ended. If the server never sent a finish_reason, treat the
    // turn as a normal completion.
    for (const event of parser.finalize()) yield event;
  }
}
