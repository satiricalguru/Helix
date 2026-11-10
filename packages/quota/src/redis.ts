/**
 * Redis-backed quota store.
 *
 * The Lua scripts keep each operation atomic, which matters: a read-modify-write
 * in the application would let two concurrent requests both see the same token
 * count and both succeed.
 */

import type { QuotaStore, SpendResult, TokenBucketResult } from "./store.js";

/** Minimal interface so the package does not hard-depend on ioredis types. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const TAKE_TOKEN_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])

local t = redis.call('TIME')
local now = tonumber(t[1]) + (tonumber(t[2]) / 1000000)

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + (elapsed * refill))

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
local ttl = math.ceil((capacity / refill) * 1000) + 60000
redis.call('PEXPIRE', key, ttl)

return { allowed, tostring(tokens) }
`;

const RELEASE_TOKEN_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])

local t = redis.call('TIME')
local now = tonumber(t[1]) + (tonumber(t[2]) / 1000000)

local tokens = tonumber(redis.call('HGET', key, 'tokens') or '0')
tokens = math.min(capacity, tokens + 1)
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
return tokens
`;

const RESERVE_LUA = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

local spent = tonumber(redis.call('HGET', key, 'spent') or '0')
local held = tonumber(redis.call('HGET', key, 'held') or '0')
local total = spent + held + amount

if total > limit then
  return { 0, tostring(math.max(0, limit - spent - held)) }
end

redis.call('HINCRBY', key, 'held', amount)
redis.call('EXPIRE', key, 86400)
return { 1, tostring(limit - total) }
`;

const SETTLE_LUA = `
local key = KEYS[1]
local reserved = tonumber(ARGV[1])
local actual = tonumber(ARGV[2])

redis.call('HINCRBY', key, 'held', -reserved)
redis.call('HINCRBY', key, 'spent', actual)
redis.call('EXPIRE', key, 86400)
return tonumber(redis.call('HGET', key, 'spent') or '0')
`;

const RELEASE_LUA = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
redis.call('HINCRBY', key, 'held', -amount)
redis.call('EXPIRE', key, 86400)
return 1
`;

const SPEND_LUA = `
local key = KEYS[1]
local spent = tonumber(redis.call('HGET', key, 'spent') or '0')
local held = tonumber(redis.call('HGET', key, 'held') or '0')
return tostring(spent + held)
`;

export class RedisQuotaStore implements QuotaStore {
  #redis: RedisLike;

  constructor(redis: RedisLike) {
    this.#redis = redis;
  }

  async takeToken(
    key: string,
    opts: { capacity: number; refillPerSecond: number },
  ): Promise<TokenBucketResult> {
    const refill = opts.refillPerSecond > 0 ? opts.refillPerSecond : 0.000001;
    const result = (await this.#redis.eval(TAKE_TOKEN_LUA, 1, key, opts.capacity, refill)) as [
      number,
      string,
    ];
    const allowed = Number(result[0]) === 1;
    const remaining = Math.max(0, Math.floor(Number(result[1])));
    const deficit = Math.max(0, opts.capacity - remaining);
    return {
      allowed,
      remaining,
      capacity: opts.capacity,
      resetSeconds:
        opts.refillPerSecond > 0 ? Math.ceil(deficit / opts.refillPerSecond) : 0,
    };
  }

  async refundToken(
    key: string,
    opts: { capacity: number; refillPerSecond: number },
  ): Promise<void> {
    const refill = opts.refillPerSecond > 0 ? opts.refillPerSecond : 0.000001;
    await this.#redis.eval(RELEASE_TOKEN_LUA, 1, key, opts.capacity, refill);
  }

  async reserve(key: string, amount: number, limit: number): Promise<SpendResult> {
    const result = (await this.#redis.eval(RESERVE_LUA, 1, key, amount, limit)) as [
      number,
      string,
    ];
    const allowed = Number(result[0]) === 1;
    return { allowed, remaining: Math.max(0, Number(result[1])), limit };
  }

  async settle(key: string, reserved: number, actual: number, limit: number): Promise<SpendResult> {
    await this.#redis.eval(SETTLE_LUA, 1, key, reserved, actual);
    return { allowed: true, remaining: Math.max(0, limit - actual), limit };
  }

  async release(key: string, amount: number): Promise<void> {
    await this.#redis.eval(RELEASE_LUA, 1, key, amount);
  }

  async spend(key: string): Promise<number> {
    const result = (await this.#redis.eval(SPEND_LUA, 1, key)) as string;
    return Number(result);
  }
}
