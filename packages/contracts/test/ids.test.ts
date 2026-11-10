import { describe, expect, it } from "vitest";
import {
  messageBatchId,
  messageId,
  randomId,
  requestId,
  serverToolUseId,
  toolUseId,
  uuidV7,
} from "../src/ids.js";

describe("id prefixes", () => {
  it("uses the Anthropic prefixes", () => {
    expect(messageId()).toMatch(/^msg_[A-Za-z0-9]{24}$/);
    expect(toolUseId()).toMatch(/^toolu_[A-Za-z0-9]{24}$/);
    expect(requestId()).toMatch(/^req_[A-Za-z0-9]{24}$/);
    expect(serverToolUseId()).toMatch(/^srvtoolu_[A-Za-z0-9]{24}$/);
    expect(messageBatchId()).toMatch(/^msgbatch_[A-Za-z0-9]{24}$/);
  });

  it("never repeats", () => {
    const ids = new Set(Array.from({ length: 500 }, () => messageId()));
    expect(ids.size).toBe(500);
  });
});

describe("randomId", () => {
  it("uses the requested length", () => {
    expect(randomId()).toHaveLength(24);
    expect(randomId(8)).toHaveLength(8);
    expect(randomId(64)).toHaveLength(64);
  });

  it("only uses characters Anthropic ids contain", () => {
    expect(randomId(200)).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe("uuidV7", () => {
  it("is a well-formed UUID with the version and variant bits set", () => {
    const uuid = uuidV7();
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("encodes the current timestamp in the high bits", () => {
    const before = Date.now();
    const uuid = uuidV7();
    const after = Date.now();
    const hex = uuid.replace(/-/g, "");
    const ms = parseInt(hex.slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(after + 1000);
  });

  it("sorts by creation time", () => {
    const first = uuidV7();
    const second = uuidV7();
    expect(first <= second).toBe(true);
  });

  it("is unique across rapid calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidV7()));
    expect(ids.size).toBe(1000);
  });
});
