import { describe, expect, it } from "vitest";
import { McpClient, McpClientError } from "../src/index.js";
import { META_CLIENT_INFO, META_PROTOCOL_VERSION } from "@helix/contracts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("McpClient — identity", () => {
  it("reports its own identity by default", async () => {
    let body: { params?: { _meta?: Record<string, unknown> } } = {};
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } });
    }) as unknown as typeof fetch;

    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    await client.listTools();
    const info = body.params?._meta?.[META_CLIENT_INFO] as { name: string };
    expect(info.name).toBe("helix");
  });

  it("forwards the identity of the client that is actually connected", async () => {
    let body: { params?: { _meta?: Record<string, unknown> } } = {};
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } });
    }) as unknown as typeof fetch;

    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    await client.listTools({
      clientInfo: { name: "claude-ai", title: "Claude", version: "1.0.0" },
    });
    const info = body.params?._meta?.[META_CLIENT_INFO] as { name: string; title: string };
    expect(info.name).toBe("claude-ai");
    expect(info.title).toBe("Claude");
  });

  it("fills in a version when the caller omits one", async () => {
    // The 2026-07-28 envelope requires clientInfo.version; a partial identity
    // is rejected by a strict server.
    let body: { params?: { _meta?: Record<string, unknown> } } = {};
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } });
    }) as unknown as typeof fetch;

    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    await client.listTools({ clientInfo: { name: "helix", title: "Helix" } });
    const info = body.params?._meta?.[META_CLIENT_INFO] as { name: string; version: string };
    expect(info.version).toBeTruthy();
    expect(typeof info.version).toBe("string");
  });
});

describe("McpClient — per-call credentials", () => {
  it("uses the per-call token when one is given", async () => {
    const headers: Record<string, string> = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      headers.push(...Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => `${k}=${v}`));
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } });
    }) as unknown as typeof fetch;

    const client = new McpClient({ url: "https://mcp.example/mcp", token: "default-token", fetchImpl });
    await client.listTools({ token: "tenant-token" });
    expect(headers.join("\n")).toContain("authorization=Bearer tenant-token");
    expect(headers.join("\n")).not.toContain("default-token");
  });

  it("falls back to the default token", async () => {
    let auth: string | undefined;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } });
    }) as unknown as typeof fetch;

    const client = new McpClient({ url: "https://mcp.example/mcp", token: "default-token", fetchImpl });
    await client.listTools();
    expect(auth).toBe("Bearer default-token");
  });
});

describe("McpClient — protocol metadata", () => {
  it("sends the protocol version in _meta and in the header", async () => {
    let body: { params?: { _meta?: Record<string, unknown> } } = {};
    let headerVersion: string | undefined;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      headerVersion = (init?.headers as Record<string, string> | undefined)?.["mcp-protocol-version"];
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } });
    }) as unknown as typeof fetch;

    const client = new McpClient({
      url: "https://mcp.example/mcp",
      protocolVersion: "2026-07-28",
      fetchImpl,
    });
    await client.listTools();
    expect(headerVersion).toBe("2026-07-28");
    expect(body.params?._meta?.[META_PROTOCOL_VERSION]).toBe("2026-07-28");
  });

  it("sends Mcp-Name for a tool call", async () => {
    let nameHeader: string | undefined;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      nameHeader = (init?.headers as Record<string, string> | undefined)?.["mcp-name"];
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { resultType: "complete", content: [{ type: "text", text: "ok" }] },
      });
    }) as unknown as typeof fetch;

    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    await client.callTool("generate_video", { prompt: "x" });
    expect(nameHeader).toBe("generate_video");
  });
});

describe("McpClient — errors", () => {
  it("raises a typed error on a non-2xx response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    await expect(client.listTools()).rejects.toBeInstanceOf(McpClientError);
  });

  it("raises on a JSON-RPC error", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32022, message: "Unsupported" } })) as unknown as typeof fetch;
    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    await expect(client.listTools()).rejects.toThrow(/Unsupported/);
  });

  it("reads an SSE-framed response", async () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "complete", tools: [{ name: "t", inputSchema: { type: "object" } }] },
    });
    const fetchImpl = (async () =>
      new Response(`event: message\ndata: ${payload}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    expect((await client.listTools()).map((t) => t.name)).toEqual(["t"]);
  });
});
