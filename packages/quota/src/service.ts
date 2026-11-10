/**
 * Quota policy: turns the raw primitives into admission decisions.
 */

import type { QuotaStore, TokenBucketResult } from "./store.js";

export interface RateLimitPolicy {
  /** Maximum requests per window. */
  rpm: number;
  /** Window length in seconds. Defaults to 60. */
  windowSeconds?: number;
}

export interface BudgetPolicy {
  /** Maximum spend in USD over the window. */
  maxUsd: number;
  /** Window label, used in the budget key (e.g. "day", "month"). */
  window: string;
}

export interface AdmissionRequest {
  /** Tenant or key identifier. */
  subject: string;
  rateLimit?: RateLimitPolicy;
  budget?: BudgetPolicy;
  /** Cost estimate to hold against the budget. */
  estimatedUsd?: number;
}

export type Admission =
  | { allowed: true; rateLimit?: TokenBucketResult; reservedUsd: number }
  | {
      allowed: false;
      reason: "rate_limit" | "budget";
      message: string;
      retryAfterSeconds: number;
      rateLimit?: TokenBucketResult;
    };

export interface BudgetReservation {
  key: string;
  amount: number;
  limit: number;
}

export class QuotaService {
  #store: QuotaStore;

  constructor(store: QuotaStore) {
    this.#store = store;
  }

  #rateKey(subject: string): string {
    return `rl:${subject}`;
  }

  #budgetKey(subject: string, window: string): string {
    return `budget:${window}:${subject}`;
  }

  /** Decide whether a request may proceed, holding budget if allowed. */
  async admit(request: AdmissionRequest): Promise<Admission> {
    let rateLimit: TokenBucketResult | undefined;

    if (request.rateLimit) {
      const rpm = request.rateLimit.rpm;
      const windowSeconds = request.rateLimit.windowSeconds ?? 60;
      // A token bucket refilling at rpm/60 requests per second enforces the
      // same average rate while allowing a controlled burst.
      rateLimit = await this.#store.takeToken(this.#rateKey(request.subject), {
        capacity: rpm,
        refillPerSecond: rpm / windowSeconds,
      });
      if (!rateLimit.allowed) {
        return {
          allowed: false,
          reason: "rate_limit",
          message: `Rate limit exceeded: ${rpm} requests per ${windowSeconds}s.`,
          retryAfterSeconds: Math.max(1, rateLimit.resetSeconds),
          rateLimit,
        };
      }
    }

    let reservedUsd = 0;
    if (request.budget && request.estimatedUsd && request.estimatedUsd > 0) {
      const key = this.#budgetKey(request.subject, request.budget.window);
      const result = await this.#store.reserve(
        key,
        request.estimatedUsd,
        request.budget.maxUsd,
      );
      if (!result.allowed) {
        // Release the token we just took: the request is not proceeding.
        if (request.rateLimit) {
          await this.#store.refundToken(this.#rateKey(request.subject), {
            capacity: request.rateLimit.rpm,
            refillPerSecond: request.rateLimit.rpm / (request.rateLimit.windowSeconds ?? 60),
          });
        }
        return {
          allowed: false,
          reason: "budget",
          message: `Spend limit reached for this ${request.budget.window} ($${request.budget.maxUsd.toFixed(2)}).`,
          retryAfterSeconds: 3600,
          rateLimit,
        };
      }
      reservedUsd = request.estimatedUsd;
    }

    return { allowed: true, rateLimit, reservedUsd };
  }

  /** Settle a reservation against the actual spend. */
  async settle(reservation: BudgetReservation, actualUsd: number): Promise<void> {
    if (reservation.amount <= 0) return;
    await this.#store.settle(
      reservation.key,
      reservation.amount,
      actualUsd,
      reservation.limit,
    );
  }

  /** Release a reservation without spending it. */
  async release(reservation: BudgetReservation): Promise<void> {
    if (reservation.amount <= 0) return;
    await this.#store.release(reservation.key, reservation.amount);
  }

  /** Current spend against a budget window. */
  async spent(subject: string, window: string): Promise<number> {
    return this.#store.spend(this.#budgetKey(subject, window));
  }

  /** Build the reservation record for a budget. */
  reservationFor(subject: string, budget: BudgetPolicy, amount: number): BudgetReservation {
    return {
      key: this.#budgetKey(subject, budget.window),
      amount,
      limit: budget.maxUsd,
    };
  }
}
