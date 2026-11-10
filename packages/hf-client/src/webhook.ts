/**
 * Higgsfield webhook verification.
 *
 * Higgsfield signs webhooks with a `webhook-signature` header carrying one or
 * more space-separated `v1,<base64>` signatures, alongside `webhook-id` and
 * `webhook-timestamp`. The exact signed payload is not published, so the
 * scheme is configurable here and defaults to the common
 * `<id>.<timestamp>.<body>` construction. A legacy `X-Webhook-Secret-Key`
 * header is also accepted for shared-secret comparison.
 *
 * Verification is mandatory: an unverified webhook could be forged to make
 * Helix report a generation as complete when it is not.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookHeaders {
  "webhook-id"?: string | null;
  "webhook-timestamp"?: string | null;
  "webhook-signature"?: string | null;
  "x-webhook-secret-key"?: string | null;
}

export interface VerifyOptions {
  /** The shared secret used to sign webhooks. */
  secret: string;
  /** Reject deliveries whose timestamp is older than this (seconds). */
  toleranceSeconds?: number;
  /** Override the signed payload construction. */
  buildSignedPayload?: (id: string, timestamp: string, rawBody: string) => string;
  /** Injectable clock for tests. */
  now?: () => number;
}

export type WebhookVerification =
  | { ok: true; webhookId: string }
  | { ok: false; reason: string };

const defaultBuild = (id: string, timestamp: string, rawBody: string) =>
  `${id}.${timestamp}.${rawBody}`;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function verifyWebhook(
  headers: WebhookHeaders,
  rawBody: string,
  options: VerifyOptions,
): WebhookVerification {
  const webhookId = headers["webhook-id"] ?? "";
  const timestamp = headers["webhook-timestamp"] ?? "";
  const signatureHeader = headers["webhook-signature"];

  if (!webhookId) return { ok: false, reason: "missing webhook-id" };
  if (!timestamp) return { ok: false, reason: "missing webhook-timestamp" };

  // Reject stale deliveries to bound the replay window.
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ? options.now() : Date.now();
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "invalid webhook-timestamp" };
  // `timestamp` is in seconds; `now` is in milliseconds.
  if (Math.abs(now - sentAt * 1000) > tolerance * 1000) {
    return { ok: false, reason: "webhook timestamp outside tolerance" };
  }

  // Legacy shared-secret header.
  const legacySecret = headers["x-webhook-secret-key"];
  if (!signatureHeader && legacySecret) {
    if (safeEqual(legacySecret, options.secret)) return { ok: true, webhookId };
    return { ok: false, reason: "legacy secret mismatch" };
  }

  if (!signatureHeader) return { ok: false, reason: "missing webhook-signature" };

  const build = options.buildSignedPayload ?? defaultBuild;
  const expected = createHmac("sha256", options.secret)
    .update(build(webhookId, timestamp, rawBody))
    .digest("base64");

  const candidates = signatureHeader
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));

  if (candidates.length === 0) return { ok: false, reason: "no v1 signature present" };

  for (const candidate of candidates) {
    if (safeEqual(candidate, expected)) return { ok: true, webhookId };
  }
  return { ok: false, reason: "signature mismatch" };
}

/**
 * A small deduplicator keyed by webhook id.
 *
 * Higgsfield retries deliveries, so the same webhook id can arrive more than
 * once; processing it twice would double-count a generation.
 */
export class WebhookDeduplicator {
  #seen = new Map<string, number>();
  #ttlMs: number;
  #max: number;

  constructor(opts: { ttlMs?: number; max?: number } = {}) {
    this.#ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.#max = opts.max ?? 10_000;
  }

  /** Returns true the first time an id is seen, false on a repeat. */
  markOnce(id: string, now = Date.now()): boolean {
    const existing = this.#seen.get(id);
    if (existing !== undefined && now - existing < this.#ttlMs) return false;
    if (this.#seen.size >= this.#max) {
      // Drop the oldest entry rather than growing without bound.
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, ts] of this.#seen) {
        if (ts < oldest) {
          oldest = ts;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) this.#seen.delete(oldestKey);
    }
    this.#seen.set(id, now);
    return true;
  }

  get size(): number {
    return this.#seen.size;
  }
}
