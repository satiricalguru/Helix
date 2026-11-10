import { describe, expect, it } from "vitest";
import { isTransientNetworkError } from "../src/index.js";

/** Build an error shaped like Node's undici network failures. */
function networkError(code: string, name = "Error"): Error {
  const err = new TypeError("fetch failed");
  (err as unknown as { cause: { code: string; name: string } }).cause = { code, name };
  return err;
}

describe("isTransientNetworkError", () => {
  it("treats DNS failures as transient", () => {
    expect(isTransientNetworkError(networkError("ENOTFOUND"))).toBe(true);
    expect(isTransientNetworkError(networkError("EAI_AGAIN"))).toBe(true);
  });

  it("treats connection resets and refusals as transient", () => {
    expect(isTransientNetworkError(networkError("ECONNRESET"))).toBe(true);
    expect(isTransientNetworkError(networkError("ECONNREFUSED"))).toBe(true);
    expect(isTransientNetworkError(networkError("EPIPE"))).toBe(true);
  });

  it("treats connect timeouts as transient", () => {
    expect(isTransientNetworkError(networkError("UND_ERR_CONNECT_TIMEOUT", "ConnectTimeoutError"))).toBe(true);
    expect(isTransientNetworkError(networkError("ETIMEDOUT"))).toBe(true);
  });

  it("treats a bare 'fetch failed' as transient", () => {
    expect(isTransientNetworkError(new TypeError("fetch failed"))).toBe(true);
  });

  it("does not treat an abort as transient", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    expect(isTransientNetworkError(aborted)).toBe(false);
  });

  it("does not treat an ordinary error as transient", () => {
    expect(isTransientNetworkError(new Error("boom"))).toBe(false);
  });
});
