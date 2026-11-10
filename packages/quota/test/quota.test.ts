import { describe, expect, it } from "vitest";
import { InMemoryQuotaStore } from "../src/store.js";
import { QuotaService } from "../src/service.js";

function service(now = () => 1_000_000) {
  const store = new InMemoryQuotaStore({ now });
  return { store, quota: new QuotaService(store) };
}

describe("InMemoryQuotaStore — token bucket", () => {
  it("allows up to the capacity then refuses", async () => {
    const store = new InMemoryQuotaStore();
    const opts = { capacity: 3, refillPerSecond: 0 };
    expect((await store.takeToken("k", opts)).allowed).toBe(true);
    expect((await store.takeToken("k", opts)).allowed).toBe(true);
    expect((await store.takeToken("k", opts)).allowed).toBe(true);
    expect((await store.takeToken("k", opts)).allowed).toBe(false);
  });

  it("refills continuously", async () => {
    let now = 0;
    const store = new InMemoryQuotaStore({ now: () => now });
    const opts = { capacity: 2, refillPerSecond: 1 };
    expect((await store.takeToken("k", opts)).allowed).toBe(true);
    expect((await store.takeToken("k", opts)).allowed).toBe(true);
    expect((await store.takeToken("k", opts)).allowed).toBe(false);
    now += 1000;
    expect((await store.takeToken("k", opts)).allowed).toBe(true);
  });

  it("never exceeds the capacity", async () => {
    let now = 0;
    const store = new InMemoryQuotaStore({ now: () => now });
    const opts = { capacity: 2, refillPerSecond: 10 };
    await store.takeToken("k", opts);
    now += 100_000;
    const result = await store.takeToken("k", opts);
    expect(result.remaining).toBeLessThanOrEqual(2);
  });

  it("keeps separate buckets per key", async () => {
    const store = new InMemoryQuotaStore();
    const opts = { capacity: 1, refillPerSecond: 0 };
    expect((await store.takeToken("a", opts)).allowed).toBe(true);
    expect((await store.takeToken("b", opts)).allowed).toBe(true);
    expect((await store.takeToken("a", opts)).allowed).toBe(false);
  });

  it("reports the reset time", async () => {
    const store = new InMemoryQuotaStore();
    const result = await store.takeToken("k", { capacity: 10, refillPerSecond: 1 });
    expect(result.resetSeconds).toBeGreaterThan(0);
  });
});

describe("InMemoryQuotaStore — spend", () => {
  it("reserves against the limit", async () => {
    const store = new InMemoryQuotaStore();
    expect((await store.reserve("k", 5, 10)).allowed).toBe(true);
    // Reserving exactly up to the limit is allowed; beyond it is not.
    expect((await store.reserve("k", 5, 10)).allowed).toBe(true);
    expect((await store.reserve("k", 1, 10)).allowed).toBe(false);
  });

  it("counts held reservations against the limit", async () => {
    const store = new InMemoryQuotaStore();
    await store.reserve("k", 8, 10);
    expect((await store.reserve("k", 3, 10)).allowed).toBe(false);
  });

  it("settles a reservation against the actual spend", async () => {
    const store = new InMemoryQuotaStore();
    await store.reserve("k", 5, 10);
    await store.settle("k", 5, 3, 10);
    expect(await store.spend("k")).toBe(3);
    expect((await store.reserve("k", 7, 10)).allowed).toBe(true);
  });

  it("releases a reservation", async () => {
    const store = new InMemoryQuotaStore();
    await store.reserve("k", 5, 10);
    await store.release("k", 5);
    expect(await store.spend("k")).toBe(0);
  });

  it("never lets the held amount go negative", async () => {
    const store = new InMemoryQuotaStore();
    await store.release("k", 10);
    expect(await store.spend("k")).toBe(0);
  });
});

describe("QuotaService.admit", () => {
  it("allows a request within the rate limit", async () => {
    const { quota } = service();
    const decision = await quota.admit({ subject: "t1", rateLimit: { rpm: 10 } });
    expect(decision.allowed).toBe(true);
  });

  it("refuses a request over the rate limit", async () => {
    const { quota } = service();
    await quota.admit({ subject: "t1", rateLimit: { rpm: 1 } });
    const decision = await quota.admit({ subject: "t1", rateLimit: { rpm: 1 } });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("rate_limit");
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("keeps rate limits per subject", async () => {
    const { quota } = service();
    await quota.admit({ subject: "t1", rateLimit: { rpm: 1 } });
    const other = await quota.admit({ subject: "t2", rateLimit: { rpm: 1 } });
    expect(other.allowed).toBe(true);
  });

  it("reserves budget when an estimate is supplied", async () => {
    const { quota, store } = service();
    const decision = await quota.admit({
      subject: "t1",
      budget: { maxUsd: 10, window: "day" },
      estimatedUsd: 2.5,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.reservedUsd).toBe(2.5);
    expect(await store.spend("budget:day:t1")).toBe(2.5);
  });

  it("refuses when the budget does not fit", async () => {
    const { quota } = service();
    const decision = await quota.admit({
      subject: "t1",
      budget: { maxUsd: 1, window: "day" },
      estimatedUsd: 5,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("budget");
  });

  it("gives the rate-limit token back when the budget refuses", async () => {
    const { quota } = service();
    const first = await quota.admit({
      subject: "t1",
      rateLimit: { rpm: 1 },
      budget: { maxUsd: 0, window: "day" },
      estimatedUsd: 1,
    });
    expect(first.allowed).toBe(false);
    // The rate-limit slot was released, so a later budget-free request passes.
    const second = await quota.admit({ subject: "t1", rateLimit: { rpm: 1 } });
    expect(second.allowed).toBe(true);
  });

  it("does not touch the budget when no estimate is supplied", async () => {
    const { quota, store } = service();
    await quota.admit({ subject: "t1", budget: { maxUsd: 10, window: "day" } });
    expect(await store.spend("budget:day:t1")).toBe(0);
  });
});

describe("QuotaService — settle and release", () => {
  it("settles the actual spend", async () => {
    const { quota, store } = service();
    const decision = await quota.admit({
      subject: "t1",
      budget: { maxUsd: 10, window: "day" },
      estimatedUsd: 5,
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const reservation = quota.reservationFor("t1", { maxUsd: 10, window: "day" }, decision.reservedUsd);
    await quota.settle(reservation, 2);
    expect(await store.spend("budget:day:t1")).toBe(2);
  });

  it("releases a reservation on failure", async () => {
    const { quota, store } = service();
    const decision = await quota.admit({
      subject: "t1",
      budget: { maxUsd: 10, window: "day" },
      estimatedUsd: 5,
    });
    if (!decision.allowed) throw new Error("expected admission");
    const reservation = quota.reservationFor("t1", { maxUsd: 10, window: "day" }, decision.reservedUsd);
    await quota.release(reservation);
    expect(await store.spend("budget:day:t1")).toBe(0);
  });

  it("reports spend for a subject and window", async () => {
    const { quota } = service();
    await quota.admit({
      subject: "t1",
      budget: { maxUsd: 10, window: "day" },
      estimatedUsd: 3,
    });
    expect(await quota.spent("t1", "day")).toBe(3);
    expect(await quota.spent("t1", "month")).toBe(0);
  });
});
