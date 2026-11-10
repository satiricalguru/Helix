import { describe, expect, it } from "vitest";
import { formatSseComment, formatSseEvent, parseSseStream, readSse, SseWriter } from "../src/anthropic/sse.js";

describe("formatSseEvent", () => {
  it("emits a named event followed by data and a blank line", () => {
    const frame = formatSseEvent({ type: "ping" });
    expect(frame).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });

  it("preserves the full payload", () => {
    const frame = formatSseEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });
    expect(frame).toContain('event: content_block_delta');
    expect(frame).toContain('"delta":{"type":"text_delta","text":"Hello"}');
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("never emits a bare data frame (clients dispatch on the event name)", () => {
    const frame = formatSseEvent({ type: "message_stop" });
    expect(frame.startsWith("event: message_stop")).toBe(true);
  });
});

describe("SseWriter", () => {
  it("writes each event as its own frame", () => {
    const chunks: string[] = [];
    const w = new SseWriter({ write: (c) => chunks.push(c) });
    w.event({ type: "message_start", message: {} as never });
    w.event({ type: "message_stop" });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("event: message_start");
    expect(chunks[1]).toContain("event: message_stop");
  });

  it("emits keepalive comments", () => {
    const chunks: string[] = [];
    const w = new SseWriter({ write: (c) => chunks.push(c) });
    w.comment();
    expect(chunks[0]).toBe(": keepalive\n\n");
  });

  it("drops writes after close", () => {
    const chunks: string[] = [];
    const w = new SseWriter({ write: (c) => chunks.push(c) });
    w.close();
    w.event({ type: "ping" });
    expect(chunks).toHaveLength(0);
    expect(w.closed).toBe(true);
  });
});

describe("parseSseStream", () => {
  it("parses a single frame", () => {
    const state = { event: null as string | null, data: [] as string[], lastEventId: null as string | null };
    const out = [...parseSseStream('event: ping\ndata: {"type":"ping"}\n\n', state)];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ event: "ping", data: '{"type":"ping"}' });
  });

  it("parses several frames at once", () => {
    const state = { event: null as string | null, data: [] as string[], lastEventId: null as string | null };
    const out = [
      ...parseSseStream(
        'event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}\n\n',
        state,
      ),
    ];
    expect(out.map((r) => r.event)).toEqual(["a", "b"]);
  });

  it("joins multi-line data payloads with newlines", () => {
    const state = { event: null as string | null, data: [] as string[], lastEventId: null as string | null };
    const out = [...parseSseStream("event: x\ndata: line1\ndata: line2\n\n", state)];
    expect(out[0]!.data).toBe("line1\nline2");
  });

  it("ignores comment lines", () => {
    const state = { event: null as string | null, data: [] as string[], lastEventId: null as string | null };
    const out = [...parseSseStream(": keepalive\n\nevent: ping\ndata: {}\n\n", state)];
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toBe("ping");
  });

  it("handles CRLF line endings", () => {
    const state = { event: null as string | null, data: [] as string[], lastEventId: null as string | null };
    const out = [...parseSseStream('event: ping\r\ndata: {"type":"ping"}\r\n\r\n', state)];
    expect(out[0]!.data).toBe('{"type":"ping"}');
  });
});

describe("readSse", () => {
  async function* chunks(...parts: string[]) {
    for (const p of parts) yield new TextEncoder().encode(p);
  }

  it("reassembles frames split across byte boundaries", async () => {
    const out = [];
    for await (const rec of readSse(chunks('event: ping\nda', 'ta: {"type":"ping"}\n\n'))) out.push(rec);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ event: "ping", data: '{"type":"ping"}' });
  });

  it("yields multiple records", async () => {
    const out = [];
    for await (const rec of readSse(chunks('event: a\ndata: {"n":1}\n\n', 'event: b\ndata: {"n":2}\n\n'))) {
      out.push(rec);
    }
    expect(out.map((r) => r.event)).toEqual(["a", "b"]);
  });

  it("handles a stream that ends without a trailing blank line", async () => {
    const out = [];
    for await (const rec of readSse(chunks('event: ping\ndata: {"type":"ping"}\n'))) out.push(rec);
    expect(out).toHaveLength(1);
  });
});
