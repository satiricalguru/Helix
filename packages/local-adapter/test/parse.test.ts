import { describe, expect, it } from "vitest";
import { OpenAiChunkParser, upstreamErrorType } from "../src/parse.js";

describe("OpenAiChunkParser — text", () => {
  it("emits a text event for content", () => {
    const p = new OpenAiChunkParser();
    const events = p.parse({ choices: [{ delta: { content: "Hi" } }] });
    expect(events).toEqual([{ kind: "text", text: "Hi" }]);
  });

  it("ignores empty content", () => {
    const p = new OpenAiChunkParser();
    expect(p.parse({ choices: [{ delta: { content: "" } }] })).toEqual([]);
  });

  it("ignores null content", () => {
    const p = new OpenAiChunkParser();
    expect(p.parse({ choices: [{ delta: { content: null } }] })).toEqual([]);
  });
});

describe("OpenAiChunkParser — reasoning", () => {
  it("reads reasoning_content", () => {
    const p = new OpenAiChunkParser();
    expect(p.parse({ choices: [{ delta: { reasoning_content: "thinking..." } }] })).toEqual([
      { kind: "thinking", text: "thinking..." },
    ]);
  });

  it("reads the reasoning alias", () => {
    const p = new OpenAiChunkParser();
    expect(p.parse({ choices: [{ delta: { reasoning: "alt" } }] })).toEqual([{ kind: "thinking", text: "alt" }]);
  });
});

describe("OpenAiChunkParser — tool calls", () => {
  it("emits tool_start then tool_args", () => {
    const p = new OpenAiChunkParser();
    const first = p.parse({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "generate_video", arguments: "" } },
            ],
          },
        },
      ],
    });
    expect(first).toEqual([{ kind: "tool_start", index: 0, id: "call_1", name: "generate_video" }]);

    const second = p.parse({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"prompt":"cat"}' } }] } }],
    });
    expect(second).toEqual([{ kind: "tool_args", index: 0, partialJson: '{"prompt":"cat"}' }]);
  });

  it("does not repeat tool_start for continuation chunks", () => {
    const p = new OpenAiChunkParser();
    p.parse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f" } }] } }] });
    const second = p.parse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] });
    expect(second.some((e) => e.kind === "tool_start")).toBe(false);
  });

  it("tracks multiple tool calls independently", () => {
    const p = new OpenAiChunkParser();
    p.parse({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "c0", function: { name: "a" } },
              { index: 1, id: "c1", function: { name: "b" } },
            ],
          },
        },
      ],
    });
    const events = p.parse({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: "{}" } },
              { index: 1, function: { arguments: "{}" } },
            ],
          },
        },
      ],
    });
    expect(events.filter((e) => e.kind === "tool_args").map((e) => (e as { index: number }).index)).toEqual([0, 1]);
  });

  it("closes open tool calls when the finish reason arrives", () => {
    const p = new OpenAiChunkParser();
    p.parse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f" } }] } }] });
    const events = p.parse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    expect(events).toContainEqual({ kind: "tool_end", index: 0 });
    expect(events).toContainEqual({ kind: "finish", stopReason: "tool_use", stopSequence: null });
  });
});

describe("OpenAiChunkParser — finish reasons", () => {
  const cases: Array<[string, string]> = [
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["content_filter", "refusal"],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${input} to ${expected}`, () => {
      const p = new OpenAiChunkParser();
      const events = p.parse({ choices: [{ delta: {}, finish_reason: input }] });
      const finish = events.find((e) => e.kind === "finish");
      expect(finish).toMatchObject({ stopReason: expected });
    });
  }

  it("does not treat a null finish_reason as the end of the turn", () => {
    const p = new OpenAiChunkParser();
    const events = p.parse({ choices: [{ delta: { content: "partial" }, finish_reason: null }] });
    expect(events.some((e) => e.kind === "finish")).toBe(false);
    expect(p.sawFinish).toBe(false);
  });

  it("finalizes with end_turn when the stream ends without a finish reason", () => {
    const p = new OpenAiChunkParser();
    p.parse({ choices: [{ delta: { content: "partial" } }] });
    expect(p.sawFinish).toBe(false);
    const final = p.finalize();
    expect(final).toEqual([{ kind: "finish", stopReason: "end_turn", stopSequence: null }]);
  });

  it("finalize is a no-op once a finish reason was seen", () => {
    const p = new OpenAiChunkParser();
    p.parse({ choices: [{ delta: {}, finish_reason: "stop" }] });
    expect(p.finalize()).toEqual([]);
  });
});

describe("OpenAiChunkParser — usage", () => {
  it("maps usage with Anthropic post-breakpoint input semantics", () => {
    const p = new OpenAiChunkParser();
    const events = p.parse({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 120,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 40 },
      },
    });
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toMatchObject({
      usage: {
        inputTokens: 200,
        cacheReadTokens: 800,
        outputTokens: 120,
        thinkingTokens: 40,
      },
    });
  });

  it("handles usage without cache details", () => {
    const p = new OpenAiChunkParser();
    const events = p.parse({ usage: { prompt_tokens: 50, completion_tokens: 10 } });
    expect(events[0]).toMatchObject({ usage: { inputTokens: 50, cacheReadTokens: 0, outputTokens: 10 } });
  });

  it("treats usage as cumulative", () => {
    const p = new OpenAiChunkParser();
    p.parse({ usage: { prompt_tokens: 10, completion_tokens: 1 } });
    const events = p.parse({ usage: { prompt_tokens: 10, completion_tokens: 9 } });
    expect(events[0]).toMatchObject({ usage: { outputTokens: 9 } });
    expect(p.usage.outputTokens).toBe(9);
  });
});

describe("upstreamErrorType", () => {
  it("maps statuses onto Anthropic error types", () => {
    expect(upstreamErrorType(400)).toBe("invalid_request_error");
    expect(upstreamErrorType(401)).toBe("authentication_error");
    expect(upstreamErrorType(403)).toBe("permission_error");
    expect(upstreamErrorType(404)).toBe("not_found_error");
    expect(upstreamErrorType(429)).toBe("rate_limit_error");
    expect(upstreamErrorType(500)).toBe("api_error");
    expect(upstreamErrorType(504)).toBe("timeout_error");
    expect(upstreamErrorType(529)).toBe("overloaded_error");
  });
});
