import { describe, expect, it } from "vitest";
import {
  AnthropicApiError,
  invalidRequest,
  notFound,
  rateLimited,
  toAnthropicError,
  upstreamError,
} from "../src/anthropic/errors.js";

describe("AnthropicApiError", () => {
  it("serialises to the Anthropic error body shape", () => {
    const e = invalidRequest("bad thing", "req_abc");
    expect(e.toBody()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "bad thing" },
      request_id: "req_abc",
    });
  });

  it("includes details when present", () => {
    const e = rateLimited("slow down", "req_abc", { error_code: "gateway_tpm_exceeded" });
    expect(e.toBody().error.details).toEqual({ error_code: "gateway_tpm_exceeded" });
  });

  it("marks retryable error types as retryable", () => {
    expect(rateLimited("x", "r").retryable).toBe(true);
    expect(upstreamError("x", "r").retryable).toBe(true);
    expect(invalidRequest("x", "r").retryable).toBe(false);
    expect(notFound("x", "r").retryable).toBe(false);
  });

  it("maps status codes the way Anthropic does", () => {
    expect(invalidRequest("x", "r").status).toBe(400);
    expect(notFound("x", "r").status).toBe(404);
    expect(rateLimited("x", "r").status).toBe(429);
    expect(upstreamError("x", "r").status).toBe(500);
  });

  it("carries the request id on the error itself", () => {
    expect(invalidRequest("x", "req_zzz").requestId).toBe("req_zzz");
  });
});

describe("toAnthropicError", () => {
  it("passes Anthropic errors through untouched", () => {
    const original = invalidRequest("original", "req_1");
    expect(toAnthropicError(original, "req_2")).toBe(original);
  });

  it("wraps an unknown Error as an api_error", () => {
    const e = toAnthropicError(new Error("boom"), "req_3");
    expect(e.type).toBe("api_error");
    expect(e.status).toBe(500);
    expect(e.message).toBe("boom");
    expect(e.requestId).toBe("req_3");
  });

  it("wraps a non-Error throw", () => {
    const e = toAnthropicError("plain string", "req_4");
    expect(e.type).toBe("api_error");
    expect(e.message).toBe("plain string");
  });
});
