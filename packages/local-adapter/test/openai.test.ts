import { describe, expect, it } from "vitest";
import { toOpenAiRequest, DEFAULT_FEATURES } from "../src/openai.js";
import type { MessagesRequest } from "@helix/contracts";

const req = (overrides: Partial<MessagesRequest> = {}): MessagesRequest =>
  ({
    model: "helix-fable-5-2",
    max_tokens: 256,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }) as MessagesRequest;

describe("toOpenAiRequest — basics", () => {
  it("maps the model and enables streaming with usage", () => {
    const out = toOpenAiRequest(req(), { model: "qwen3:32b" });
    expect(out.model).toBe("qwen3:32b");
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("omits max_tokens when it is zero (cache prewarm)", () => {
    const out = toOpenAiRequest(req({ max_tokens: 0 }), { model: "m" });
    expect(out.max_tokens).toBeUndefined();
  });

  it("passes max_tokens through when positive", () => {
    const out = toOpenAiRequest(req({ max_tokens: 512 }), { model: "m" });
    expect(out.max_tokens).toBe(512);
  });

  it("maps stop_sequences to stop", () => {
    const out = toOpenAiRequest(req({ stop_sequences: ["END", "STOP"] }), { model: "m" });
    expect(out.stop).toEqual(["END", "STOP"]);
  });

  it("maps metadata.user_id to user", () => {
    const out = toOpenAiRequest(req({ metadata: { user_id: "tenant-7" } }), { model: "m" });
    expect(out.user).toBe("tenant-7");
  });
});

describe("toOpenAiRequest — system prompt", () => {
  it("prepends a system message for a string system prompt", () => {
    const out = toOpenAiRequest(req({ system: "be terse" }), { model: "m" });
    expect(out.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(out.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("joins system text blocks", () => {
    const out = toOpenAiRequest(
      req({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
      { model: "m" },
    );
    expect(out.messages[0]!.content).toBe("a\nb");
  });

  it("skips an empty system prompt", () => {
    const out = toOpenAiRequest(req({ system: "   " }), { model: "m" });
    expect(out.messages[0]!.role).toBe("user");
  });
});

describe("toOpenAiRequest — tool calls", () => {
  it("maps assistant tool_use blocks to tool_calls", () => {
    const out = toOpenAiRequest(
      req({
        messages: [
          { role: "user", content: "make a video" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "generate_video", input: { prompt: "cat" } }],
          },
          { role: "user", content: "ok" },
        ],
      }),
      { model: "m" },
    );
    const assistant = out.messages.find((msg) => msg.role === "assistant");
    expect(assistant?.tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "generate_video", arguments: '{"prompt":"cat"}' } },
    ]);
  });

  it("maps user tool_result blocks to role:tool messages", () => {
    const out = toOpenAiRequest(
      req({
        messages: [
          { role: "user", content: "make a video" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "generate_video", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "https://cdn/x.mp4" }],
          },
        ],
      }),
      { model: "m" },
    );
    const toolMsg = out.messages.find((msg) => msg.role === "tool");
    expect(toolMsg).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "https://cdn/x.mp4" });
    // The tool result must precede any text in the same turn.
    const toolIdx = out.messages.findIndex((msg) => msg.role === "tool");
    const assistantIdx = out.messages.findIndex((msg) => msg.role === "assistant");
    expect(toolIdx).toBeGreaterThan(assistantIdx);
  });

  it("flattens tool_result content blocks into text", () => {
    const out = toOpenAiRequest(
      req({
        messages: [
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] }] },
        ],
      }),
      { model: "m" },
    );
    expect(out.messages.find((m) => m.role === "tool")?.content).toBe("part1\npart2");
  });

  it("applies the tool name map when present", () => {
    const out = toOpenAiRequest(
      req({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "mcp__helix__generate_video", input: {} }],
          },
          { role: "user", content: "ok" },
        ],
      }),
      { model: "m", toolNameMap: new Map([["mcp__helix__generate_video", "generate_video"]]) },
    );
    const assistant = out.messages.find((msg) => msg.role === "assistant");
    expect(assistant?.tool_calls?.[0]?.function.name).toBe("generate_video");
  });

  it("maps Anthropic tool definitions to OpenAI function tools", () => {
    const out = toOpenAiRequest(
      req({
        tools: [
          {
            name: "generate_video",
            description: "Make a video",
            input_schema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
          },
        ],
      }),
      { model: "m" },
    );
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "generate_video",
          description: "Make a video",
          parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        },
      },
    ]);
  });

  it("maps tool_choice auto and none", () => {
    expect(toOpenAiRequest(req({ tool_choice: { type: "auto" } }), { model: "m" }).tool_choice).toBe("auto");
    expect(toOpenAiRequest(req({ tool_choice: { type: "none" } }), { model: "m" }).tool_choice).toBe("none");
  });
});

describe("toOpenAiRequest — effort and structured output", () => {
  it("omits reasoning_effort when the server does not support it", () => {
    const out = toOpenAiRequest(req({ output_config: { effort: "high" } }), { model: "m" });
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("passes reasoning_effort through when supported", () => {
    const out = toOpenAiRequest(req({ output_config: { effort: "medium" } }), {
      model: "m",
      features: { ...DEFAULT_FEATURES, reasoningEffort: true },
    });
    expect(out.reasoning_effort).toBe("medium");
  });

  it("clamps xhigh and max to high", () => {
    const features = { ...DEFAULT_FEATURES, reasoningEffort: true };
    expect(toOpenAiRequest(req({ output_config: { effort: "xhigh" } }), { model: "m", features }).reasoning_effort).toBe("high");
    expect(toOpenAiRequest(req({ output_config: { effort: "max" } }), { model: "m", features }).reasoning_effort).toBe("high");
  });

  it("maps json_schema output to response_format when supported", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const out = toOpenAiRequest(req({ output_config: { format: { type: "json_schema", schema } } }), {
      model: "m",
      features: { ...DEFAULT_FEATURES, jsonSchema: true },
    });
    expect(out.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "structured_output", schema, strict: true },
    });
  });

  it("omits response_format when the server does not support it", () => {
    const out = toOpenAiRequest(
      req({ output_config: { format: { type: "json_schema", schema: { type: "object" } } } }),
      { model: "m" },
    );
    expect(out.response_format).toBeUndefined();
  });
});

describe("toOpenAiRequest — thinking blocks", () => {
  it("never forwards thinking text to the upstream model", () => {
    const out = toOpenAiRequest(
      req({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "secret reasoning", signature: "sig" },
              { type: "text", text: "answer" },
            ],
          },
          { role: "user", content: "again" },
        ],
      }),
      { model: "m" },
    );
    const assistant = out.messages.find((msg) => msg.role === "assistant");
    expect(assistant?.content).toBe("answer");
    expect(JSON.stringify(out.messages)).not.toContain("secret reasoning");
  });
});
