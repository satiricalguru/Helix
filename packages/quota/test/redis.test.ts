import { describe, expect, it } from "vitest";
import { RedisQuotaStore, type RedisLike } from "../src/redis.js";

/**
 * A stub that records the Lua calls and returns canned results, so the
 * JavaScript side of the store — argument marshalling and result parsing —
 * is covered without a Redis server.
 */
function stubRedis(responses: unknown[] = []) {
  const calls: Array<{ script: string; numKeys: number; args: (string | number)[] }> = [];
  let index = 0;
  const redis: RedisLike = {
    eval: (async (script: string, numKeys: number, ...args: (string | number)[]) => {
      calls.push({ script, numKeys, args });
      const response = responses[index++];
      return response ?? [1, "0"];
    }) as RedisLike["eval"],
  };
  return { redis, calls };
}

describe("RedisQuotaStore — takeToken", () => {
  it("passes the key, capacity and refill rate", async () => {
    const { redis, calls } = stubRedis([[1, "9"]]);
    const store = new RedisQuotaStore(redis);
    await store.takeToken("rl:tenant", { capacity: 10, refillPerSecond: 0.5 });
    expect(calls[0]!.numKeys).toBe(1);
    expect(calls[0]!.args[0]).toBe("rl:tenant");
    expect(calls[0]!.args[1]).toBe(10);
    expect(calls[0]!.args[2]).toBe(0.5);
  });

  it("parses an allowed result", async () => {
    const { redis } = stubRedis([[1, "7"]]);
    const store = new RedisQuotaStore(redis);
    const result = await store.takeToken("k", { capacity: 10, refillPerSecond: 1 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(7);
    expect(result.capacity).toBe(10);
  });

  it("parses a denied result", async () => {
    const { redis } = stubRedis([[0, "0"]]);
    const store = new RedisQuotaStore(redis);
    const result = await store.takeToken("k", { capacity: 10, refillPerSecond: 1 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("computes the reset time from the deficit", async () => {
    const { redis } = stubRedis([[1, "2"]]);
    const store = new RedisQuotaStore(redis);
    const result = await store.takeToken("k", { capacity: 10, refillPerSecond: 2 });
    // 8 tokens short at 2 per second is 4 seconds.
    expect(result.resetSeconds).toBe(4);
  });

  it("never divides by a zero refill rate", async () => {
    const { redis, calls } = stubRedis([[1, "0"]]);
    const store = new RedisQuotaStore(redis);
    const result = await store.takeToken("k", { capacity: 10, refillPerSecond: 0 });
    expect(calls[0]!.args[2]).toBeGreaterThan(0);
    expect(result.resetSeconds).toBe(0);
  });
});

describe("RedisQuotaStore — budget", () => {
  it("reserves against the limit", async () => {
    const { redis, calls } = stubRedis([[1, "4.5"]]);
    const store = new RedisQuotaStore(redis);
    const result = await store.reserve("budget:day:t", 5.5, 10);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4.5);
    expect(calls[0]!.args).toEqual(["budget:day:t", 5.5, 10]);
  });

  it("reports a refused reservation", async () => {
    const { redis } = stubRedis([[0, "0"]]);
    const store = new RedisQuotaStore(redis);
    const result = await store.reserve("k", 11, 10);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("settles a reservation", async () => {
    const { redis, calls } = stubRedis([5]);
    const store = new RedisQuotaStore(redis);
    const result = await store.settle("k", 5, 3, 10);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(7);
    expect(calls[0]!.args).toEqual(["k", 5, 3]);
  });

  it("releases a reservation", async () => {
    const { redis, calls } = stubRedis([1]);
    const store = new RedisQuotaStore(redis);
    await store.release("k", 5);
    expect(calls[0]!.args).toEqual(["k", 5]);
  });

  it("reads the current spend", async () => {
    const { redis } = stubRedis(["12.25"]);
    const store = new RedisQuotaStore(redis);
    expect(await store.spend("k")).toBe(12.25);
  });
});

describe("RedisQuotaStore — token refunds", () => {
  it("returns a token to the bucket", async () => {
    const { redis, calls } = stubRedis([10]);
    const store = new RedisQuotaStore(redis);
    await store.refundToken("rl:tenant", { capacity: 10, refillPerSecond: 1 });
    expect(calls[0]!.args[0]).toBe("rl:tenant");
    expect(calls[0]!.args[1]).toBe(10);
  });
});
