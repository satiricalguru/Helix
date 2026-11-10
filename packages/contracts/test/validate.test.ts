import { describe, expect, it } from "vitest";
import {
  AnthropicApiError,
  FABLE_5_2,
  isLatestApiVersion,
  validateMessagesRequest,
} from "../src/anthropic/validate.js";

const RID = "req_test_0000000000000001";

/** Build a minimal valid request body. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-fable-5-2",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function validate(b: unknown, version = "2026-10-21") {
  return validateMessagesRequest(b, FABLE_5_2, { anthropicVersion: version, requestId: RID });
}

/** Assert the call throws an Anthropic error with the given status/type. */
function expectError(fn: () => unknown, status: number, type: string, messageIncludes?: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AnthropicApiError);
    const e = err as AnthropicApiError;
    expect(e.status).toBe(status);
    expect(e.type).toBe(type);
    expect(e.requestId).toBe(RID);
    if (messageIncludes) expect(e.message).toContain(messageIncludes);
    return e;
  }
  throw new Error("expected the call to throw");
}

describe("validateMessagesRequest — happy path", () => {
  it("accepts a minimal request", () => {
    const res = validate(body());
    expect(res.request.model).toBe("claude-fable-5-2");
    expect(res.request.max_tokens).toBe(1024);
    expect(res.isCachePrewarm).toBe(false);
    expect(res.effort).toBe("high"); // Fable's default effort
  });

  it("treats max_tokens: 0 as a cache prewarm", () => {
    const res = validate(body({ max_tokens: 0 }));
    expect(res.isCachePrewarm).toBe(true);
  });

  it("resolves effort from output_config, defaulting to high", () => {
    expect(validate(body()).effort).toBe("high");
    expect(validate(body({ output_config: { effort: "low" } })).effort).toBe("low");
    expect(validate(body({ output_config: { effort: "max" } })).effort).toBe("max");
  });

  it("accepts every effort level Fable supports", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const res = validate(body({ output_config: { effort } }));
      expect(res.effort).toBe(effort);
    }
  });

  it("collects echoed thinking blocks with their positions", () => {
    const res = validate(
      body({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
          },
          { role: "user", content: "again" },
        ],
      }),
    );
    expect(res.thinkingBlocks).toHaveLength(1);
    expect(res.thinkingBlocks[0]).toMatchObject({
      messageIndex: 1,
      blockIndex: 0,
      signature: "sig",
      thinking: "hmm",
    });
  });

  it("accepts adaptive thinking and an omitted thinking config", () => {
    expect(() => validate(body({ thinking: { type: "adaptive" } }))).not.toThrow();
    expect(() => validate(body({ thinking: { type: "adaptive", display: "omitted" } }))).not.toThrow();
  });

  it("accepts json_schema structured output", () => {
    expect(() =>
      validate(
        body({
          output_config: {
            format: { type: "json_schema", schema: { type: "object", properties: { a: { type: "string" } } } },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("accepts auto and none tool_choice", () => {
    expect(() => validate(body({ tool_choice: { type: "auto" } }))).not.toThrow();
    expect(() => validate(body({ tool_choice: { type: "none" } }))).not.toThrow();
  });

  it("accepts tool definitions", () => {
    const res = validate(
      body({
        tools: [{ name: "generate_video", input_schema: { type: "object", properties: {} } }],
        tool_choice: { type: "auto" },
      }),
    );
    expect(res.request.tools).toHaveLength(1);
  });

  it("accepts a system prompt as a string or as text blocks", () => {
    expect(() => validate(body({ system: "you are helpful" }))).not.toThrow();
    expect(() =>
      validate(body({ system: [{ type: "text", text: "you are helpful" }] })),
    ).not.toThrow();
  });

  it("accepts metadata.user_id up to 512 chars", () => {
    expect(() => validate(body({ metadata: { user_id: "u" } }))).not.toThrow();
    expect(() => validate(body({ metadata: { user_id: "x".repeat(512) } }))).not.toThrow();
    expectError(() => validate(body({ metadata: { user_id: "x".repeat(513) } })), 400, "invalid_request_error", "512");
  });

  it("accepts stop_sequences, stream, speed and service_tier", () => {
    expect(() => validate(body({ stop_sequences: ["END"] }))).not.toThrow();
    expect(() => validate(body({ stream: true }))).not.toThrow();
    expect(() => validate(body({ speed: "fast" }))).not.toThrow();
    expect(() => validate(body({ service_tier: "standard_only" }))).not.toThrow();
  });
});

describe("validateMessagesRequest — sampling parameters", () => {
  it("rejects temperature under the 2026-10-21 version", () => {
    expectError(
      () => validate(body({ temperature: 0.7 })),
      400,
      "invalid_request_error",
      "temperature",
    );
  });

  it("rejects top_p and top_k under the 2026-10-21 version", () => {
    expectError(() => validate(body({ top_p: 0.9 })), 400, "invalid_request_error", "top_p");
    expectError(() => validate(body({ top_k: 40 })), 400, "invalid_request_error", "top_k");
  });

  it("rejects the default values too, under 2026-10-21", () => {
    expectError(() => validate(body({ temperature: 1 })), 400, "invalid_request_error");
    expectError(() => validate(body({ top_p: 1 })), 400, "invalid_request_error");
  });

  it("still rejects non-default values under the legacy 2023-06-01 version", () => {
    expectError(
      () => validate(body({ temperature: 0.7 }), "2023-06-01"),
      400,
      "invalid_request_error",
      "temperature",
    );
  });

  it("allows the default value under the legacy version", () => {
    expect(() => validate(body({ temperature: 1 }), "2023-06-01")).not.toThrow();
  });

  it("rejects top_k under every version because it has no default", () => {
    expectError(() => validate(body({ top_k: 40 }), "2023-06-01"), 400, "invalid_request_error", "top_k");
  });

  it("knows which version is the latest", () => {
    expect(isLatestApiVersion("2026-10-21")).toBe(true);
    expect(isLatestApiVersion("2023-06-01")).toBe(false);
    expect(isLatestApiVersion(undefined)).toBe(false);
  });
});

describe("validateMessagesRequest — thinking configuration", () => {
  it("rejects thinking.type=enabled with Anthropic's wording", () => {
    const e = expectError(
      () => validate(body({ thinking: { type: "enabled", budget_tokens: 2048 } })),
      400,
      "invalid_request_error",
      '"thinking.type.enabled" is not supported for this model',
    );
    expect(e.message).toContain("output_config.effort");
  });

  it("rejects thinking.type=disabled", () => {
    expectError(
      () => validate(body({ thinking: { type: "disabled" } })),
      400,
      "invalid_request_error",
      '"thinking.type.disabled" is not supported for this model',
    );
  });

  it("rejects thinking.type=between_tools", () => {
    expectError(
      () => validate(body({ thinking: { type: "between_tools" } })),
      400,
      "invalid_request_error",
      '"thinking.type.between_tools" is not supported for this model',
    );
  });

  it("rejects budget_tokens alongside adaptive thinking", () => {
    expectError(
      () => validate(body({ thinking: { type: "adaptive", budget_tokens: 2048 } })),
      400,
      "invalid_request_error",
      "Extra inputs are not permitted",
    );
  });

  it("requires a thinking type", () => {
    expectError(() => validate(body({ thinking: {} })), 400, "invalid_request_error", "thinking.type");
  });
});

describe("validateMessagesRequest — tool_choice", () => {
  it("rejects forced tool use with Anthropic's wording", () => {
    const e = expectError(
      () => validate(body({ tool_choice: { type: "any" } })),
      400,
      "invalid_request_error",
      'tool_choice: type "tool" and "any" are not supported for this model',
    );
    expect(e.message).toContain("not supported for this model");
  });

  it("rejects tool_choice.type=tool", () => {
    expectError(
      () => validate(body({ tool_choice: { type: "tool", name: "generate_video" } })),
      400,
      "invalid_request_error",
      "not supported for this model",
    );
  });
});

describe("validateMessagesRequest — structural validation", () => {
  it("rejects a non-object body", () => {
    expectError(() => validate("nope"), 400, "invalid_request_error", "JSON object");
    expectError(() => validate(null), 400, "invalid_request_error");
    expectError(() => validate([]), 400, "invalid_request_error");
  });

  it("requires model", () => {
    expectError(() => validate({ max_tokens: 10, messages: [] }), 400, "invalid_request_error", "model");
  });

  it("requires max_tokens", () => {
    expectError(() => validate({ model: "claude-fable-5-2", messages: [] }), 400, "invalid_request_error", "max_tokens");
  });

  it("rejects a negative max_tokens", () => {
    expectError(() => validate(body({ max_tokens: -1 })), 400, "invalid_request_error", "max_tokens");
  });

  it("rejects max_tokens above the model ceiling", () => {
    expectError(
      () => validate(body({ max_tokens: 200_000 })),
      400,
      "invalid_request_error",
      "131072",
    );
  });

  it("requires a non-empty messages array", () => {
    expectError(() => validate(body({ messages: [] })), 400, "invalid_request_error", "at least 1 item");
    expectError(() => validate(body({ messages: "hi" })), 400, "invalid_request_error", "messages");
  });

  it("rejects an unknown role", () => {
    expectError(
      () => validate(body({ messages: [{ role: "robot", content: "hi" }] })),
      400,
      "invalid_request_error",
      "messages.0.role",
    );
  });

  it("rejects assistant prefill", () => {
    const e = expectError(
      () =>
        validate(
          body({
            messages: [
              { role: "user", content: "hi" },
              { role: "assistant", content: "The answer is (" },
            ],
          }),
        ),
      400,
      "invalid_request_error",
      "does not support assistant message prefill",
    );
    expect(e.message).toContain("must end with a user message");
  });

  it("rejects a trailing system message", () => {
    expectError(
      () =>
        validate(
          body({
            messages: [
              { role: "user", content: "hi" },
              { role: "system", content: "be brief" },
            ],
          }),
        ),
      400,
      "invalid_request_error",
      'must use the "user" role',
    );
  });

  it("rejects a malformed content block", () => {
    expectError(
      () => validate(body({ messages: [{ role: "user", content: [{ type: "text" }] }] })),
      400,
      "invalid_request_error",
      "messages.0.content.0.text",
    );
  });

  it("rejects a tool_use block without an id", () => {
    expectError(
      () =>
        validate(
          body({
            messages: [
              { role: "user", content: "hi" },
              { role: "assistant", content: [{ type: "tool_use", name: "x" }] },
              { role: "user", content: "ok" },
            ],
          }),
        ),
      400,
      "invalid_request_error",
      "messages.1.content.0",
    );
  });

  it("rejects a tool_result block without tool_use_id", () => {
    expectError(
      () => validate(body({ messages: [{ role: "user", content: [{ type: "tool_result" }] }] })),
      400,
      "invalid_request_error",
      "tool_use_id",
    );
  });

  it("rejects an invalid tool name", () => {
    expectError(
      () => validate(body({ tools: [{ name: "bad name!", input_schema: { type: "object" } }] })),
      400,
      "invalid_request_error",
      "tools.0.name",
    );
  });

  it("rejects a tool without an input_schema", () => {
    expectError(() => validate(body({ tools: [{ name: "ok" }] })), 400, "invalid_request_error", "input_schema");
  });

  it("rejects an unknown effort level", () => {
    expectError(
      () => validate(body({ output_config: { effort: "extreme" } })),
      400,
      "invalid_request_error",
      "output_config.effort",
    );
  });

  it("rejects a non-json_schema output format", () => {
    expectError(
      () => validate(body({ output_config: { format: { type: "xml" } } })),
      400,
      "invalid_request_error",
      "output_config.format.type",
    );
  });

  it("rejects non-string stop_sequences entries", () => {
    expectError(() => validate(body({ stop_sequences: [1] })), 400, "invalid_request_error", "stop_sequences");
  });

  it("rejects an invalid speed value", () => {
    expectError(() => validate(body({ speed: "turbo" })), 400, "invalid_request_error", "speed");
  });

  it("rejects an invalid service_tier", () => {
    expectError(() => validate(body({ service_tier: "premium" })), 400, "invalid_request_error", "service_tier");
  });
});

describe("model spec", () => {
  it("describes Fable 5.2 exactly", () => {
    expect(FABLE_5_2.line).toBe("fable");
    expect(FABLE_5_2.maxInputTokens).toBe(1_000_000);
    expect(FABLE_5_2.maxOutputTokens).toBe(131_072);
    expect(FABLE_5_2.defaultEffort).toBe("high");
    expect(FABLE_5_2.minCacheableTokens).toBe(512);
    expect(FABLE_5_2.allowsSamplingParams).toBe(false);
  });
});
