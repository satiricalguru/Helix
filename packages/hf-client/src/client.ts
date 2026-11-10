/**
 * Higgsfield API client.
 *
 * Generation is asynchronous: submit -> request_id -> poll or webhook ->
 * terminal status -> output URLs. The client keeps the credential server-side,
 * always sends an `Idempotency-Key` so an ambiguous timeout can be retried
 * without creating a duplicate request, and honours `Retry-After` when the
 * account queue is full.
 */

import type {
  HfCompletedResponse,
  HfStatusResponse,
  HfSubmitResponse,
} from "@helix/contracts";
import { HF_BASE_URL } from "@helix/contracts";

export interface HfCredentials {
  keyId: string;
  keySecret: string;
}

export interface HfClientOptions {
  credentials: HfCredentials;
  baseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

export class HfApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly body: string;

  constructor(opts: {
    status: number;
    body: string;
    code?: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
  }) {
    super(`Higgsfield API returned ${opts.status}${opts.code ? ` (${opts.code})` : ""}`);
    this.name = "HfApiError";
    this.status = opts.status;
    this.body = opts.body;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export class HfClient {
  #opts: HfClientOptions;
  #fetch: typeof fetch;

  constructor(opts: HfClientOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  get baseUrl(): string {
    return (this.#opts.baseUrl ?? HF_BASE_URL).replace(/\/$/, "");
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Key ${this.#opts.credentials.keyId}:${this.#opts.credentials.keySecret}`,
      ...extra,
    };
  }

  /**
   * Submit a generation request.
   *
   * @param endpointId e.g. "higgsfield/cinema-studio/4.0"
   * @param input      the model-specific request body
   */
  async submit(
    endpointId: string,
    input: Record<string, unknown>,
    opts: {
      idempotencyKey?: string;
      /** HTTPS endpoint that receives the completion webhook. */
      webhookUrl?: string;
      /** Seconds to keep the request data after it finishes. */
      expiresAfter?: number;
    } = {},
  ): Promise<HfSubmitResponse> {
    const url = new URL(`${this.baseUrl}/${endpointId}`);
    if (opts.webhookUrl) url.searchParams.set("hf_webhook", opts.webhookUrl);

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    if (opts.expiresAfter !== undefined) headers["hf-expires-after"] = String(opts.expiresAfter);

    const response = await this.#request(url.toString(), {
      method: "POST",
      headers: this.#headers(headers),
      body: JSON.stringify(input),
    });

    return (await response.json()) as HfSubmitResponse;
  }

  /** Poll a request's status. */
  async getStatus(requestId: string): Promise<HfStatusResponse> {
    const response = await this.#request(
      `${this.baseUrl}/requests/${encodeURIComponent(requestId)}/status`,
      { method: "GET", headers: this.#headers() },
    );
    return (await response.json()) as HfStatusResponse;
  }

  /** Cancel a request. Only valid while it is still queued. */
  async cancel(requestId: string): Promise<void> {
    await this.#request(
      `${this.baseUrl}/requests/${encodeURIComponent(requestId)}/cancel`,
      { method: "POST", headers: this.#headers() },
    );
  }

  /** Delete a finished request's files and parameters. */
  async delete(requestId: string): Promise<void> {
    await this.#request(`${this.baseUrl}/requests/${encodeURIComponent(requestId)}`, {
      method: "DELETE",
      headers: this.#headers(),
    });
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = this.#opts.timeoutMs
      ? setTimeout(() => controller.abort(), this.#opts.timeoutMs)
      : undefined;
    let response: Response;
    try {
      response = await this.#fetch(url, { ...init, signal: controller.signal });
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw toHfError(response.status, body, response.headers.get("retry-after"));
    }
    return response;
  }
}

/** Translate a Higgsfield error response into a typed error. */
export function toHfError(status: number, body: string, retryAfterHeader: string | null): HfApiError {
  let code: string | undefined;
  let message: string | undefined;
  let retryable = false;
  let retryAfterSeconds: number | undefined;

  try {
    const parsed = JSON.parse(body) as {
      detail?: string | { code?: string; message?: string; retryable?: boolean; retry_after_seconds?: number };
    };
    if (typeof parsed.detail === "string") {
      message = parsed.detail;
    } else if (parsed.detail && typeof parsed.detail === "object") {
      code = parsed.detail.code;
      message = parsed.detail.message;
      retryable = parsed.detail.retryable ?? false;
      retryAfterSeconds = parsed.detail.retry_after_seconds;
    }
  } catch {
    message = body.slice(0, 300);
  }

  if (retryAfterSeconds === undefined && retryAfterHeader) {
    const parsed = Number(retryAfterHeader);
    if (Number.isFinite(parsed)) retryAfterSeconds = parsed;
  }
  if (status === 429) retryable = true;
  if (status === 503) retryable = true;

  return new HfApiError({
    status,
    body,
    code,
    retryable,
    retryAfterSeconds,
  });
}

/** True when a status is terminal. */
export const TERMINAL_STATUSES = new Set(["completed", "failed", "nsfw", "canceled"]);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Extract every output URL from a completed response. */
export function outputUrls(response: HfStatusResponse | HfCompletedResponse): string[] {
  const urls: string[] = [];
  if (response.images) urls.push(...response.images.map((i) => i.url));
  if (response.video?.url) urls.push(response.video.url);
  if (response.audio?.url) urls.push(response.audio.url);
  if (response.audios) urls.push(...response.audios.map((a) => a.url));
  for (const key of ["zip", "mov", "jsx", "fbx", "ply"] as const) {
    const artifact = response[key] as { url?: string } | undefined;
    if (artifact?.url) urls.push(artifact.url);
  }
  return urls;
}
