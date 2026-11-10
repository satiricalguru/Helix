import { describe, expect, it } from "vitest";
import { buildRelayTools } from "../src/tools.js";
import { UpstreamConnector } from "../src/upstream.js";
import { META_CLIENT_INFO, META_PROTOCOL_VERSION } from "@helix/contracts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("the relay — tool shape", () => {
  it("exposes generate_video and generate_image", () => {
    const upstream = new UpstreamConnector({ url: "https://mcp.example/mcp" });
    const names = buildRelayTools({ upstream }).map((t) => t.name);
    expect(names).toContain("generate_video");
    expect(names).toContain("generate_image");
  });

  it("can be restricted to a subset", () => {
    const upstream = new UpstreamConnector({ url: "https://mcp.example/mcp" });
    const names = buildRelayTools({ upstream, only: ["generate_video"] }).map((t) => t.name);
    expect(names).toEqual(["generate_video"]);
  });

  it("documents that the output is AI-generated and consumes credits", () => {
    const upstream = new UpstreamConnector({ url: "https://mcp.example/mcp" });
    const video = buildRelayTools({ upstream }).find((t) => t.name === "generate_video")!;
    expect(video.description).toMatch(/AI-generated/);
    expect(video.description).toMatch(/consumes credits/);
  });

  it("surfaces an upstream failure as a tool error rather than throwing", async () => {
    const failing = {
      callTool: async () => {
        throw new Error("upstream is down");
      },
    } as unknown as UpstreamConnector;
    const video = buildRelayTools({ upstream: failing }).find((t) => t.name === "generate_video")!;
    const result = await video.run(
      { prompt: "x" },
      {
        subject: "t1",
        progress: () => {},
        signal: new AbortController().signal,
        idempotencyKey: "k",
      },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content[0]!.text)).toContain("upstream is down");
  });

  it("passes the upstream result through", async () => {
    const stub = {
      callTool: async () => ({
        content: [{ type: "text", text: "https://cdn/out.mp4" }],
        structuredContent: { urls: ["https://cdn/out.mp4"] },
      }),
    } as unknown as UpstreamConnector;
    const video = buildRelayTools({ upstream: stub }).find((t) => t.name === "generate_video")!;
    const result = await video.run(
      { prompt: "x" },
      {
        subject: "t1",
        progress: () => {},
        signal: new AbortController().signal,
        idempotencyKey: "k",
      },
    );
    expect(result.content[0]).toEqual({ type: "text", text: "https://cdn/out.mp4" });
    expect(result.structuredContent).toEqual({ urls: ["https://cdn/out.mp4"] });
  });

  it("maps our tool name onto the upstream's", async () => {
    let called = "";
    const stub = {
      callTool: async (name: string) => {
        called = name;
        return { content: [] };
      },
    } as unknown as UpstreamConnector;
    const video = buildRelayTools({
      upstream: stub,
      nameMap: { generate_video: "generate_video_batch" },
    }).find((t) => t.name === "generate_video")!;
    await video.run(
      { prompt: "x" },
      {
        subject: "t1",
        progress: () => {},
        signal: new AbortController().signal,
        idempotencyKey: "k",
      },
    );
    expect(called).toBe("generate_video_batch");
  });

  it("wraps the arguments when the upstream nests them", async () => {
    // Higgsfield takes every model parameter under `params`.
    let sent: Record<string, unknown> = {};
    const stub = {
      callTool: async (_name: string, args: Record<string, unknown>) => {
        sent = args;
        return { content: [] };
      },
    } as unknown as UpstreamConnector;
    const video = buildRelayTools({ upstream: stub, paramWrapper: "params" }).find(
      (t) => t.name === "generate_video",
    )!;
    await video.run(
      { prompt: "x", duration: 12 },
      {
        subject: "t1",
        progress: () => {},
        signal: new AbortController().signal,
        idempotencyKey: "k",
      },
    );
    expect(sent).toEqual({ params: { prompt: "x", duration: 12 } });
  });

  it("sends flat arguments when no wrapper is configured", async () => {
    let sent: Record<string, unknown> = {};
    const stub = {
      callTool: async (_name: string, args: Record<string, unknown>) => {
        sent = args;
        return { content: [] };
      },
    } as unknown as UpstreamConnector;
    const video = buildRelayTools({ upstream: stub }).find((t) => t.name === "generate_video")!;
    await video.run(
      { prompt: "x" },
      {
        subject: "t1",
        progress: () => {},
        signal: new AbortController().signal,
        idempotencyKey: "k",
      },
    );
    expect(sent).toEqual({ prompt: "x" });
  });
});

describe("the relay — the client identity reaches the wire", () => {
  it("is sent in the upstream request's _meta", async () => {
    let body: { params?: { _meta?: Record<string, unknown> } } = {};
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { resultType: "complete", content: [{ type: "text", text: "ok" }] },
      });
    }) as unknown as typeof fetch;

    // The MCP client takes an injectable fetch.
    const { McpClient } = await import("@helix/mcp-client");
    const client = new McpClient({ url: "https://mcp.example/mcp", token: "t", fetchImpl });
    await client.callTool(
      "generate_video",
      { prompt: "x" },
      { clientInfo: { name: "claude-ai", title: "Claude", version: "1.0.0" } },
    );
    const info = body.params?._meta?.[META_CLIENT_INFO] as { name: string; title: string };
    expect(info.name).toBe("claude-ai");
    expect(info.title).toBe("Claude");
    expect(body.params?._meta?.[META_PROTOCOL_VERSION]).toBeTruthy();
  });
});
