import { describe, expect, it } from "vitest";
import { LocalModelClient, LocalModelUpstreamError } from "../src/client.js";
import type { OpenAiChatRequest } from "../src/openai.js";

/** Build a Response whose body is an SSE stream of the given frames. */
function sseResponse(frames: string[], init: ResponseInit = {}): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

const request: OpenAiChatRequest = {
  model: "qwen3:32b",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
};

describe("LocalModelClient", () => {
  it("streams IR events from an OpenAI-compatible server", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 3 } }),
      ]);
    }) as unknown as typeof fetch;

    const client = new LocalModelClient({ baseUrl: "http://localhost:11434/v1", model: "qwen3:32b", fetchImpl });
    const events = [];
    for await (const e of client.stream(request)) events.push(e);

    expect(capturedUrl).toBe("http://localhost:11434/v1/chat/completions");
    expect(capturedInit?.method).toBe("POST");
    const body = JSON.parse(String(capturedInit?.body)) as OpenAiChatRequest;
    expect(body.model).toBe("qwen3:32b");
    expect(body.stream).toBe(true);

    expect(events).toContainEqual({ kind: "text", text: "Hel" });
    expect(events).toContainEqual({ kind: "text", text: "lo" });
    expect(events).toContainEqual({ kind: "finish", stopReason: "end_turn", stopSequence: null });
  });

  it("sends the api key as a bearer token", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: "x" } }] })]);
    }) as unknown as typeof fetch;

    const client = new LocalModelClient({
      baseUrl: "http://localhost:8080/v1",
      model: "m",
      apiKey: "secret-token",
      fetchImpl,
    });
    for await (const _ of client.stream(request)) void _;

    expect(headers.authorization).toBe("Bearer secret-token");
  });

  it("raises a typed error for a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "bad model" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const client = new LocalModelClient({ baseUrl: "http://localhost:1234/v1", model: "m", fetchImpl });
    await expect(async () => {
      for await (const _ of client.stream(request)) void _;
    }).rejects.toBeInstanceOf(LocalModelUpstreamError);
  });

  it("maps the upstream status onto an Anthropic error type", async () => {
    const fetchImpl = (async () => new Response("busy", { status: 429 })) as unknown as typeof fetch;
    const client = new LocalModelClient({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    try {
      for await (const _ of client.stream(request)) void _;
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LocalModelUpstreamError);
      expect((err as LocalModelUpstreamError).anthropicType).toBe("rate_limit_error");
      expect((err as LocalModelUpstreamError).status).toBe(429);
    }
  });

  it("skips malformed frames rather than dying", async () => {
    const fetchImpl = (async () =>
      sseResponse([
        "not json at all",
        JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
      ])) as unknown as typeof fetch;

    const client = new LocalModelClient({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    const events = [];
    for await (const e of client.stream(request)) events.push(e);
    expect(events).toContainEqual({ kind: "text", text: "ok" });
  });

  it("finalizes the turn when the server never sends a finish_reason", async () => {
    const fetchImpl = (async () =>
      sseResponse([JSON.stringify({ choices: [{ delta: { content: "partial" } }] })])) as unknown as typeof fetch;

    const client = new LocalModelClient({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    const events = [];
    for await (const e of client.stream(request)) events.push(e);
    expect(events).toContainEqual({ kind: "finish", stopReason: "end_turn", stopSequence: null });
  });

  it("strips a trailing slash from the base url", async () => {
    let url = "";
    const fetchImpl = (async (u: string | URL | Request) => {
      url = String(u);
      return sseResponse([]);
    }) as unknown as typeof fetch;
    const client = new LocalModelClient({ baseUrl: "http://x/v1/", model: "m", fetchImpl });
    for await (const _ of client.stream(request)) void _;
    expect(url).toBe("http://x/v1/chat/completions");
  });
});
