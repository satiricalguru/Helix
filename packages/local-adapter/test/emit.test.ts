import { describe, expect, it } from "vitest";
import { AnthropicStreamAssembler } from "../src/emit.js";
import { ThinkingSigner } from "../src/signature.js";
import type { AnthropicStreamEvent } from "@helix/contracts";

const signer = new ThinkingSigner("test-secret");

function makeAssembler(thinkingEnabled = true) {
  const assembler = new AnthropicStreamAssembler({
    model: "helix-fable-5-2",
    messageId: "msg_test_0000000000000001",
    thinkingEnabled,
    signer,
    conversationDigest: "digest-abc",
  });
  return assembler;
}

function drain(assembler: AnthropicStreamAssembler, events: Parameters<typeof assembler.consume>[0][]) {
  const out: AnthropicStreamEvent[] = [];
  for (const e of events) out.push(...assembler.consume(e));
  return out;
}

describe("AnthropicStreamAssembler — event ordering", () => {
  it("emits message_start, blocks, message_delta, message_stop in order", () => {
    const a = makeAssembler(false);
    const frames: AnthropicStreamEvent[] = [...a.start()];
    frames.push(
      ...drain(a, [
        { kind: "text", text: "Hello" },
        { kind: "finish", stopReason: "end_turn", stopSequence: null },
      ]),
    );
    frames.push(...a.finish());

    const types = frames.map((f) => f.type);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("emits message_start with an empty content array", () => {
    const a = makeAssembler(false);
    const start = a.start()[0]!;
    expect(start.type).toBe("message_start");
    if (start.type === "message_start") {
      expect(start.message.content).toEqual([]);
      expect(start.message.stop_reason).toBeNull();
      expect(start.message.model).toBe("helix-fable-5-2");
    }
  });

  it("refuses to start twice", () => {
    const a = makeAssembler(false);
    a.start();
    expect(() => a.start()).toThrow(/twice/);
  });

  it("is idempotent on finish", () => {
    const a = makeAssembler(false);
    a.start();
    expect(a.finish()).toHaveLength(2);
    expect(a.finish()).toHaveLength(0);
  });
});

describe("AnthropicStreamAssembler — text blocks", () => {
  it("opens one text block and appends deltas", () => {
    const a = makeAssembler(false);
    a.start();
    const frames = drain(a, [
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
    ]);
    expect(frames.filter((f) => f.type === "content_block_start")).toHaveLength(1);
    expect(frames.filter((f) => f.type === "content_block_delta")).toHaveLength(2);
    const deltas = frames.filter((f) => f.type === "content_block_delta");
    expect(deltas[0]).toMatchObject({ index: 0, delta: { type: "text_delta", text: "Hel" } });
    expect(deltas[1]).toMatchObject({ index: 0, delta: { type: "text_delta", text: "lo" } });
  });

  it("opens a second text block after a tool block", () => {
    const a = makeAssembler(false);
    a.start();
    const frames = drain(a, [
      { kind: "tool_start", index: 0, id: "toolu_1", name: "generate_video" },
      { kind: "tool_args", index: 0, partialJson: "{}" },
      { kind: "tool_end", index: 0 },
      { kind: "text", text: "done" },
    ]);
    const starts = frames.filter((f) => f.type === "content_block_start");
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ index: 0, content_block: { type: "tool_use" } });
    expect(starts[1]).toMatchObject({ index: 1, content_block: { type: "text" } });
  });
});

describe("AnthropicStreamAssembler — thinking blocks", () => {
  it("opens the thinking block first when thinking is enabled", () => {
    const a = makeAssembler(true);
    const frames = a.start();
    expect(frames.map((f) => f.type)).toEqual(["message_start", "content_block_start"]);
    expect(frames[1]).toMatchObject({
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
  });

  it("emits a signature_delta immediately before content_block_stop", () => {
    const a = makeAssembler(true);
    a.start();
    const frames = drain(a, [{ kind: "thinking", text: "let me think" }]);
    const closing = a.finish();
    const all = [...frames, ...closing];
    const sigIdx = all.findIndex((f) => f.type === "content_block_delta" && f.delta.type === "signature_delta");
    const stopIdx = all.findIndex((f) => f.type === "content_block_stop");
    expect(sigIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(sigIdx);
  });

  it("signs the thinking block and verifies with the same key", () => {
    const a = makeAssembler(true);
    a.start();
    drain(a, [{ kind: "thinking", text: "reasoning" }]);
    a.finish();
    const thinking = a.message.content.find((c) => c.type === "thinking");
    expect(thinking).toBeDefined();
    if (thinking && thinking.type === "thinking") {
      expect(thinking.thinking).toBe("reasoning");
      expect(signer.verify(thinking.signature, "digest-abc", 0, "reasoning")).toBe(true);
      expect(signer.verify(thinking.signature, "other-digest", 0, "reasoning")).toBe(false);
      expect(signer.verify(thinking.signature, "digest-abc", 0, "tampered")).toBe(false);
    }
  });

  it("does not open a thinking block when thinking is disabled", () => {
    const a = makeAssembler(false);
    a.start();
    drain(a, [{ kind: "thinking", text: "should be ignored" }]);
    a.finish();
    expect(a.message.content.find((c) => c.type === "thinking")).toBeUndefined();
  });

  it("does not open a thinking block up-front when thinking is disabled", () => {
    const a = makeAssembler(false);
    expect(a.start().map((f) => f.type)).toEqual(["message_start"]);
  });
});

describe("AnthropicStreamAssembler — tool_use blocks", () => {
  it("opens with an empty input and streams partial JSON", () => {
    const a = makeAssembler(false);
    a.start();
    const frames = drain(a, [
      { kind: "tool_start", index: 0, id: "toolu_abc", name: "generate_video" },
      { kind: "tool_args", index: 0, partialJson: '{"prompt":' },
      { kind: "tool_args", index: 0, partialJson: '"a cat"}' },
    ]);
    const start = frames.find((f) => f.type === "content_block_start");
    expect(start).toMatchObject({
      index: 0,
      content_block: { type: "tool_use", id: "toolu_abc", name: "generate_video", input: {} },
    });
    const deltas = frames.filter((f) => f.type === "content_block_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ delta: { type: "input_json_delta", partial_json: '{"prompt":' } });
  });

  it("parses the accumulated JSON into the final block", () => {
    const a = makeAssembler(false);
    a.start();
    drain(a, [
      { kind: "tool_start", index: 0, id: "toolu_abc", name: "generate_video" },
      { kind: "tool_args", index: 0, partialJson: '{"prompt":"a cat","seconds":5}' },
      { kind: "tool_end", index: 0 },
    ]);
    a.finish();
    const tool = a.message.content.find((c) => c.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      id: "toolu_abc",
      name: "generate_video",
      input: { prompt: "a cat", seconds: 5 },
    });
  });

  it("degrades gracefully when the tool arguments are malformed", () => {
    const a = makeAssembler(false);
    a.start();
    drain(a, [
      { kind: "tool_start", index: 0, id: "toolu_abc", name: "x" },
      { kind: "tool_args", index: 0, partialJson: "{not json" },
      { kind: "tool_end", index: 0 },
    ]);
    a.finish();
    const tool = a.message.content.find((c) => c.type === "tool_use");
    expect(tool).toMatchObject({ input: {} });
  });

  it("sets stop_reason to tool_use when the model asked for a tool", () => {
    const a = makeAssembler(false);
    a.start();
    drain(a, [
      { kind: "tool_start", index: 0, id: "t", name: "x" },
      { kind: "tool_args", index: 0, partialJson: "{}" },
      { kind: "tool_end", index: 0 },
      { kind: "finish", stopReason: "tool_use", stopSequence: null },
    ]);
    a.finish();
    expect(a.message.stop_reason).toBe("tool_use");
  });
});

describe("AnthropicStreamAssembler — usage", () => {
  it("reports Anthropic post-breakpoint input semantics", () => {
    const a = makeAssembler(false);
    a.start();
    drain(a, [
      {
        kind: "usage",
        usage: {
          inputTokens: 100,
          cacheReadTokens: 900,
          cacheCreationTokens: 0,
          outputTokens: 42,
          thinkingTokens: 7,
        },
      },
    ]);
    a.finish();
    const u = a.message.usage;
    expect(u.input_tokens).toBe(100);
    expect(u.cache_read_input_tokens).toBe(900);
    expect(u.output_tokens).toBe(42);
    expect(u.output_tokens_details?.thinking_tokens).toBe(7);
  });

  it("treats usage events as cumulative (last one wins)", () => {
    const a = makeAssembler(false);
    a.start();
    drain(a, [
      { kind: "usage", usage: { inputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1, thinkingTokens: 0 } },
      { kind: "usage", usage: { inputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 55, thinkingTokens: 0 } },
    ]);
    a.finish();
    expect(a.message.usage.output_tokens).toBe(55);
  });

  it("includes the usage on message_delta", () => {
    const a = makeAssembler(false);
    a.start();
    drain(a, [{ kind: "usage", usage: { inputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 9, thinkingTokens: 0 } }]);
    const frames = a.finish();
    const delta = frames.find((f) => f.type === "message_delta");
    expect(delta).toMatchObject({ usage: { output_tokens: 9, input_tokens: 5 } });
  });
});

describe("AnthropicStreamAssembler — errors and pings", () => {
  it("passes a ping through", () => {
    const a = makeAssembler(false);
    a.start();
    const frames = drain(a, [{ kind: "ping" }]);
    expect(frames).toEqual([{ type: "ping" }]);
  });

  it("passes an error through and marks the assembler as errored", () => {
    const a = makeAssembler(false);
    a.start();
    const frames = drain(a, [{ kind: "error", error: { type: "overloaded_error", message: "busy" } }]);
    expect(frames[0]).toEqual({ type: "error", error: { type: "overloaded_error", message: "busy" } });
    expect(a.errored).toBe(true);
  });

  it("carries stop_sequence through to the message", () => {
    const a = makeAssembler(false);
    a.start();
    drain(a, [{ kind: "finish", stopReason: "stop_sequence", stopSequence: "END" }]);
    a.finish();
    expect(a.message.stop_reason).toBe("stop_sequence");
    expect(a.message.stop_sequence).toBe("END");
  });
});
