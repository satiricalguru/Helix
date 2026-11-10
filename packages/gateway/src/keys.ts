/**
 * Virtual key store.
 *
 * Keys are presented as `sk-helix-...` and stored only as a SHA-256 digest, so
 * a database dump does not yield usable credentials.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface VirtualKey {
  /** The key id, e.g. "sk-helix-a1b2c3". */
  id: string;
  /** SHA-256 hex digest of the secret part. */
  hash: string;
  tenantId: string;
  label: string;
  /** Advertised model ids this key may use, or "*" for all. */
  allowedModels: string[] | "*";
  /** Requests per minute. */
  rpm: number;
  /** Maximum concurrent in-flight requests. */
  maxConcurrent: number;
  /** Media spend budget per day, in USD. */
  dailyUsdBudget: number;
  expiresAt?: string;
  disabled?: boolean;
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Mint a new key. The returned secret is shown once and never stored. */
export function mintKey(opts: {
  tenantId: string;
  label?: string;
  allowedModels?: string[] | "*";
  rpm?: number;
  maxConcurrent?: number;
  dailyUsdBudget?: number;
  expiresAt?: string;
}): { key: VirtualKey; secret: string } {
  const id = `sk-helix-${randomBytes(9).toString("base64url")}`;
  const secret = randomBytes(32).toString("base64url");
  const key: VirtualKey = {
    id,
    hash: hashKey(secret),
    tenantId: opts.tenantId,
    label: opts.label ?? "default",
    allowedModels: opts.allowedModels ?? "*",
    rpm: opts.rpm ?? 120,
    maxConcurrent: opts.maxConcurrent ?? 8,
    dailyUsdBudget: opts.dailyUsdBudget ?? 10,
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
  };
  return { key, secret };
}

export class KeyStore {
  #byHash = new Map<string, VirtualKey>();

  constructor(keys: VirtualKey[] = []) {
    for (const k of keys) this.#byHash.set(k.hash, k);
  }

  add(key: VirtualKey): void {
    this.#byHash.set(key.hash, key);
  }

  get size(): number {
    return this.#byHash.size;
  }

  /** Look up a key by the secret presented by the client. */
  authenticate(presented: string): VirtualKey | undefined {
    const digest = hashKey(presented);
    const found = this.#byHash.get(digest);
    if (!found) return undefined;
    // Constant-time comparison, even though the lookup itself is by digest.
    if (!timingSafeEqual(Buffer.from(found.hash), Buffer.from(digest))) return undefined;
    return found;
  }

  /** True when the key may use the given advertised model id. */
  static allows(key: VirtualKey, modelId: string): boolean {
    if (key.allowedModels === "*") return true;
    return key.allowedModels.includes(modelId);
  }

  /** True when the key is currently usable. */
  static isActive(key: VirtualKey, now = Date.now()): boolean {
    if (key.disabled) return false;
    if (key.expiresAt) {
      const expiry = Date.parse(key.expiresAt);
      if (Number.isFinite(expiry) && expiry <= now) return false;
    }
    return true;
  }
}
