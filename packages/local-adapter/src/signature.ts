/**
 * Synthetic thinking signatures.
 *
 * Claude Fable 5.2 always emits a `thinking` block carrying an Anthropic
 * `signature`, and Anthropic rejects a thinking block whose signature does not
 * match. Helix serves its own model, so it mints its own signatures.
 *
 * These are HMAC-SHA256 digests under a per-install secret, NOT Anthropic
 * signatures. They are deliberately prefixed so they can never be confused
 * with a genuine Anthropic blob, and they are only ever checked against
 * Helix's own key.
 */

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { MessagesRequest } from "@helix/contracts";

/** Marker prefix: unmistakably not an Anthropic signature. */
const PREFIX = "hx1.";

export class ThinkingSigner {
  #secret: Buffer;

  constructor(secret: string | Buffer) {
    this.#secret = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
    if (this.#secret.length === 0) {
      throw new Error("ThinkingSigner requires a non-empty secret");
    }
  }

  /** Mint a signature for a thinking block. */
  mint(conversationDigest: string, index: number, thinking: string): string {
    const mac = createHmac("sha256", this.#secret)
      .update(conversationDigest)
      .update("\u0000")
      .update(String(index))
      .update("\u0000")
      .update(thinking)
      .digest("base64url");
    return PREFIX + mac;
  }

  /** Verify a signature previously minted by this signer. */
  verify(signature: string, conversationDigest: string, index: number, thinking: string): boolean {
    if (!signature.startsWith(PREFIX)) return false;
    const provided = signature.slice(PREFIX.length);
    const expected = this.mint(conversationDigest, index, thinking).slice(PREFIX.length);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/**
 * A digest of everything the thinking block is bound to.
 *
 * Binding to the conversation (rather than just the text) is what lets Helix
 * detect a thinking block that was moved between conversations and drop it
 * instead of trusting it.
 */
export function conversationDigest(request: MessagesRequest): string {
  const hash = createHash("sha256");
  hash.update(request.model);
  hash.update("\u0000");
  hash.update(JSON.stringify(request.tools ?? []));
  hash.update("\u0000");
  hash.update(JSON.stringify(request.system ?? null));
  hash.update("\u0000");
  for (const m of request.messages) {
    hash.update(m.role);
    hash.update("\u0000");
    hash.update(JSON.stringify(m.content));
    hash.update("\u0000");
  }
  return hash.digest("base64url");
}
