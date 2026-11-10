import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { handleMessages } from "../src/handler.js";
import { KeyStore, mintKey, hashKey, type VirtualKey } from "../src/keys.js";
import { ModelRouter } from "../src/router.js";
import { InMemoryQuotaStore, QuotaService } from "@helix/quota";
import { DEFAULT_MODEL_GROUPS, type ModelGroup } from "@helix/config";
import { LocalModelClient, ThinkingSigner } from "@helix/local-adapter";

/* ------------------------------------------------------------ helpers */

function sseBody(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

interface MockServer {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: unknown }>;
  /** The frames the mock server will return on the next request. */
  frames: string[];
  /** Set the frames the mock server returns. */
  respond: (frames: string[]) => void;
  failWith?: { status: number; body: string };
}

function mockLocalModel(): MockServer {
  const server: MockServer = {
    calls: [],
    frames: [],
    respond: (frames: string[]) => {
      server.frames = frames;
    },
    fetchImpl: (async () => new Response()) as unknown as typeof fetch,
  };
  server.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    server.calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (server.failWith) {
      return new Response(server.failWith.body, { status: server.failWith.status });
    }
    return sseBody(server.frames);
  }) as unknown as typeof fetch;
  return server;
}

function textChunk(text: string) {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}
function finishChunk(reason = "stop") {
  return JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] });
}
function usageChunk(prompt = 100, completion = 20, cached = 0) {
  return JSON.stringify({
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      prompt_tokens_details: { cached_tokens: cached },
    },
  });
}

function makeKey(overrides: Partial<VirtualKey> = {}): { key: VirtualKey; secret: string } {
  const minted = mintKey({ tenantId: "tenant-1", label: "test" });
  const key: VirtualKey = { ...minted.key, ...overrides };
  return { key, secret: minted.secret };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  server: MockServer;
  secret: string;
  key: VirtualKey;
  groups: ModelGroup[];
}

function harness(overrides: { key?: Partial<VirtualKey>; groups?: ModelGroup[] } = {}): Harness {
  const { key, secret } = makeKey(overrides.key);
  const keys = new KeyStore([key]);
  const groups = overrides.groups ?? DEFAULT_MODEL_GROUPS;
  const router = new ModelRouter(groups);
  const quota = new QuotaService(new InMemoryQuotaStore());
  const server = mockLocalModel();

  const app = createApp({
    groups,
    keys,
    router,
    quota,
    signer: new ThinkingSigner("test-secret"),
    clientFor: (deployment) =>
      new LocalModelClient({
        baseUrl: deployment.baseUrl,
        model: deployment.model,
        fetchImpl: server.fetchImpl,
      }),
    featuresFor: (deployment) => ({
      reasoningEffort: deployment.supportsReasoningEffort,
      jsonSchema: deployment.supportsJsonSchema,
      parallelToolCalls: true,
    }),
  });

  return { app, server, secret, key, groups };
}

const MODEL_ID = DEFAULT_MODEL_GROUPS[0]!.advertisedId;

function body(overrides: Record<string, unknown> = {}) {
  return {
    model: MODEL_ID,
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

/* -------------------------------------------------------------- tests */

describe("gateway — authentication", () => {
  it("rejects a request with no key", async () => {
    const h = harness();
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("authentication_error");
  });

  it("rejects an unknown key", async () => {
    const h = harness();
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-helix-nope" },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a Bearer token", async () => {
    const h = harness();
    h.server.respond([textChunk("hi"), finishChunk()]);
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(200);
  });

  it("accepts x-api-key", async () => {
    const h = harness();
    h.server.respond([textChunk("hi"), finishChunk()]);
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": h.secret },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a disabled key", async () => {
    const h = harness({ key: { disabled: true } });
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an expired key", async () => {
    const h = harness({ key: { expiresAt: "2000-01-01T00:00:00Z" } });
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(403);
  });
});

describe("gateway — model resolution", () => {
  it("returns 404 for an unknown model", async () => {
    const h = harness();
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ model: "claude-fable-5-2" })),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("not_found_error");
  });

  it("returns 403 when the key is not allowed to use the model", async () => {
    const h = harness({ key: { allowedModels: ["some-other-model"] } });
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(403);
  });
});

describe("gateway — validation", () => {
  it("returns 400 for a sampling parameter", async () => {
    const h = harness();
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ temperature: 0.7 })),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string; message: string } };
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toContain("temperature");
  });

  it("returns 400 for forced tool use", async () => {
    const h = harness();
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ tool_choice: { type: "any" } })),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-JSON body", async () => {
    const h = harness();
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("includes the request-id header on errors", async () => {
    const h = harness();
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ temperature: 1 })),
    });
    expect(res.headers.get("request-id")).toMatch(/^req_/);
  });
});

describe("gateway — non-streaming response", () => {
  it("returns an Anthropic-shaped message", async () => {
    const h = harness();
    h.server.respond([textChunk("Hello"), textChunk(" world"), finishChunk(), usageChunk(100, 20)]);
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.model).toBe(MODEL_ID);
    expect(json.id).toMatch(/^msg_/);
    expect(json.stop_reason).toBe("end_turn");
    const content = json.content as Array<{ type: string; text?: string }>;
    // The thinking block comes first, as it does in Anthropic's own output.
    expect(content[0]!.type).toBe("thinking");
    const text = content.find((c) => c.type === "text");
    expect(text).toMatchObject({ type: "text", text: "Hello world" });
  });

  it("includes the thinking block when effort is not low", async () => {
    const h = harness();
    h.server.respond([textChunk("answer"), finishChunk()]);
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ output_config: { effort: "high" } })),
    });
    const json = (await res.json()) as { content: Array<{ type: string }> };
    expect(json.content.some((c) => c.type === "thinking")).toBe(true);
  });

  it("omits the thinking block at effort low", async () => {
    const h = harness();
    h.server.respond([textChunk("answer"), finishChunk()]);
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ output_config: { effort: "low" } })),
    });
    const json = (await res.json()) as { content: Array<{ type: string }> };
    expect(json.content.some((c) => c.type === "thinking")).toBe(false);
  });

  it("reports Anthropic post-breakpoint input token semantics", async () => {
    const h = harness();
    h.server.respond([textChunk("x"), finishChunk(), usageChunk(1000, 20, 800)]);
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    const json = (await res.json()) as { usage: Record<string, number> };
    expect(json.usage.input_tokens).toBe(200);
    expect(json.usage.cache_read_input_tokens).toBe(800);
    expect(json.usage.output_tokens).toBe(20);
  });

  it("returns a tool_use block with parsed input", async () => {
    const h = harness();
    h.server.respond([
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "generate_video", arguments: "" } },
              ],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"prompt":"a cat"}' } }] } },
        ],
      }),
      finishChunk("tool_calls"),
    ]);
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ tools: [{ name: "generate_video", input_schema: { type: "object" } }] })),
    });
    const json = (await res.json()) as { content: Array<Record<string, unknown>>; stop_reason: string };
    const tool = json.content.find((c) => c.type === "tool_use");
    expect(tool).toMatchObject({ name: "generate_video", input: { prompt: "a cat" } });
    expect(json.stop_reason).toBe("tool_use");
  });

  it("attaches provenance headers", async () => {
    const h = harness();
    h.server.respond([textChunk("x"), finishChunk()]);
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    expect(res.headers.get("x-helix-upstream-provider")).toBe("local");
    expect(res.headers.get("x-helix-upstream-model")).toBeTruthy();
  });
});

describe("gateway — streaming response", () => {
  it("emits the Anthropic SSE event sequence", async () => {
    const h = harness();
    h.server.respond([textChunk("Hel"), textChunk("lo"), finishChunk(), usageChunk()]);
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ stream: true })),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events = text
      .split("\n\n")
      .filter((f) => f.trim() !== "")
      .map((f) => f.split("\n").find((l) => l.startsWith("event: "))!.slice(7));
    expect(events[0]).toBe("message_start");
    expect(events).toContain("content_block_start");
    expect(events).toContain("content_block_delta");
    expect(events).toContain("content_block_stop");
    expect(events).toContain("message_delta");
    expect(events[events.length - 1]).toBe("message_stop");
  });

  it("includes named event lines for every frame", async () => {
    const h = harness();
    h.server.respond([textChunk("x"), finishChunk()]);
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ stream: true })),
    });
    const text = await res.text();
    for (const frame of text.split("\n\n").filter((f) => f.trim() !== "")) {
      expect(frame).toMatch(/^event: [a-z_]+/);
    }
  });
});

describe("gateway — cache prewarm", () => {
  it("returns an empty message for max_tokens 0 without calling the model", async () => {
    const h = harness();
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ max_tokens: 0 })),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: unknown[]; stop_reason: string };
    expect(json.content).toEqual([]);
    expect(json.stop_reason).toBe("end_turn");
    expect(h.server.calls).toHaveLength(0);
  });
});

describe("gateway — upstream failures", () => {
  it("maps an upstream 500 to an Anthropic api_error", async () => {
    const h = harness();
    h.server.failWith = { status: 500, body: "boom" };
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("api_error");
  });

  it("maps an upstream 429 to a rate_limit_error", async () => {
    const h = harness();
    h.server.failWith = { status: 429, body: "slow down" };
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("rate_limit_error");
  });

  it("emits an error frame when a stream fails mid-flight", async () => {
    const h = harness();
    h.server.failWith = { status: 500, body: "boom" };
    const res = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body({ stream: true })),
    });
    const text = await res.text();
    expect(text).toContain("event: error");
  });
});

describe("gateway — rate limiting", () => {
  it("returns 429 once the key's rpm is exhausted", async () => {
    const h = harness({ key: { rpm: 1 } });
    h.server.respond([textChunk("x"), finishChunk()]);
    const first = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    expect(first.status).toBe(200);
    const second = await h.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify(body()),
    });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
  });
});

describe("gateway — models endpoint", () => {
  it("lists the served models with disclosure", async () => {
    const h = harness();
    const res = await h.app.request("/v1/models");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: Array<{ id: string; line: string; disclosure?: string; backend?: string }>;
    };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]!.id).toBe(MODEL_ID);
    expect(json.data[0]!.line).toBe("fable");
    expect(json.data[0]!.disclosure).toContain("local model server");
    expect(json.data[0]!.backend).toContain("local:");
  });

  it("returns 404 for an unknown model id", async () => {
    const h = harness();
    const res = await h.app.request("/v1/models/nope");
    expect(res.status).toBe(404);
  });
});

describe("gateway — count_tokens", () => {
  it("estimates the input tokens", async () => {
    const h = harness();
    const res = await h.app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}` },
      body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "hello world" }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { input_tokens: number };
    expect(json.input_tokens).toBeGreaterThan(0);
  });

  it("requires a key", async () => {
    const h = harness();
    const res = await h.app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_ID, messages: [] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("gateway — health", () => {
  it("reports liveness", async () => {
    const h = harness();
    const res = await h.app.request("/health/live");
    expect(res.status).toBe(200);
  });
});
