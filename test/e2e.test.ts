/**
 * End-to-end tests.
 *
 * These run the real servers over real sockets: a fake OpenAI-compatible
 * local model, the Anthropic-compatible gateway, and the MCP server with its
 * full OAuth flow.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createApp } from "@helix/gateway";
import { KeyStore, mintKey, ModelRouter } from "@helix/gateway";
import { ThinkingSigner, LocalModelClient } from "@helix/local-adapter";
import { DEFAULT_HF_CATALOG, DEFAULT_MODEL_GROUPS } from "@helix/config";
import { InMemoryQuotaStore, QuotaService } from "@helix/quota";
import {
  createMcpApp,
  McpServer,
  TaskStore,
  buildTools,
  InMemoryUserStore,
  OAuthServer,
  hashPassword,
} from "@helix/mcp-server";
import { createHash, randomBytes } from "node:crypto";

/* ------------------------------------------------- fake local model */

/**
 * A minimal OpenAI-compatible chat-completions server.
 *
 * It speaks real SSE over a real socket so the whole path (HTTP -> SSE parse
 * -> IR -> Anthropic SSE) is exercised.
 */
function startFakeLocalModel(): Promise<{ url: string; close: () => Promise<void>; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(body);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const frames = [
        JSON.stringify({ choices: [{ delta: { reasoning_content: "The user said hi." } }] }),
        JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
        JSON.stringify({ choices: [{ delta: { content: " from Helix." } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        JSON.stringify({
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 1000 },
            completion_tokens_details: { reasoning_tokens: 12 },
          },
        }),
      ];
      for (const f of frames) res.write(`data: ${f}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/* --------------------------------------------------------- gateway */

describe("e2e — gateway over HTTP", () => {
  let model: Awaited<ReturnType<typeof startFakeLocalModel>>;
  let app: ReturnType<typeof createApp>;
  let secret: string;

  beforeAll(async () => {
    model = await startFakeLocalModel();
    const { key, secret: s } = mintKey({ tenantId: "e2e", label: "e2e" });
    secret = s;
    const keys = new KeyStore([key]);
    const groups = DEFAULT_MODEL_GROUPS.map((g) => ({
      ...g,
      deployments: g.deployments.map((d) => ({ ...d, baseUrl: model.url })),
    }));
    app = createApp({
      groups,
      keys,
      router: new ModelRouter(groups),
      quota: new QuotaService(new InMemoryQuotaStore()),
      signer: new ThinkingSigner("e2e-secret"),
      clientFor: (deployment) =>
        new LocalModelClient({ baseUrl: deployment.baseUrl, model: deployment.model }),
    });
  });

  afterAll(async () => {
    await model.close();
  });

  it("serves an Anthropic-shaped message", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: DEFAULT_MODEL_GROUPS[0]!.advertisedId,
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type: string;
      content: Array<{ type: string; text?: string; thinking?: string }>;
      usage: { input_tokens: number; cache_read_input_tokens: number; output_tokens: number };
    };
    expect(body.type).toBe("message");
    const text = body.content.find((c) => c.type === "text");
    expect(text?.text).toBe("Hello from Helix.");
    const thinking = body.content.find((c) => c.type === "thinking");
    expect(thinking?.thinking).toBe("The user said hi.");
    expect(body.usage.input_tokens).toBe(200);
    expect(body.usage.cache_read_input_tokens).toBe(1000);
    expect(body.usage.output_tokens).toBe(30);
  });

  it("streams the Anthropic SSE sequence", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: DEFAULT_MODEL_GROUPS[0]!.advertisedId,
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = text.split("\n\n").filter((f) => f.trim() !== "");
    const events = frames.map((f) => /^event: (.+)$/m.exec(f)![1]);
    expect(events[0]).toBe("message_start");
    expect(events[events.length - 1]).toBe("message_stop");
    expect(events).toContain("content_block_delta");

    // The text must arrive as two deltas.
    const deltas = frames
      .filter((f) => f.includes("text_delta"))
      .map((f) => JSON.parse(/data: (.+)/.exec(f)![1]!) as { delta: { text: string } });
    expect(deltas.map((d) => d.delta.text)).toEqual(["Hello", " from Helix."]);
  });

  it("sends the conversation to the local model", async () => {
    model.requests.length = 0;
    await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: DEFAULT_MODEL_GROUPS[0]!.advertisedId,
        max_tokens: 64,
        messages: [{ role: "user", content: "remember this" }],
      }),
    });
    expect(model.requests).toHaveLength(1);
    const sent = JSON.parse(model.requests[0]!) as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages[0]).toEqual({ role: "user", content: "remember this" });
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", max_tokens: 1, messages: [] }),
    });
    expect(res.status).toBe(401);
  });
});

/* ---------------------------------------------------------- mcp */

describe("e2e — MCP server over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let oauth: OAuthServer;
  let users: InMemoryUserStore;

  beforeAll(async () => {
    const tools = buildTools({
      hf: undefined,
      catalog: DEFAULT_HF_CATALOG,
      quota: new QuotaService(new InMemoryQuotaStore()),
      dailyUsdBudget: 10,
    });
    const mcp = new McpServer({
      name: "helix",
      version: "0.1.0",
      instructions: "Helix generates images and video.",
      tools,
      tasks: new TaskStore(),
      enableTasks: true,
    });
    users = new InMemoryUserStore();
    await users.create("e2e@example.com", hashPassword("hunter2"));

    // Bind the socket first so the issuer URL is the one clients actually
    // reach, then attach the handler.
    server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    oauth = new OAuthServer({ issuer: baseUrl, resource: `${baseUrl}/mcp` });

    const app = createMcpApp({
      server: mcp,
      oauth,
      users,
      publicUrl: baseUrl,
    });

    server.on("request", (req, res) => {
      // Bridge Node's http server to the Fetch API properly: read the body,
      // copy the headers, and hand Hono a real Request.
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
            method: req.method,
            headers,
            ...(body.length > 0 ? { body } : {}),
          });
          try {
            const response = await app.fetch(request);
            res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch (err) {
            res.writeHead(500);
            res.end(String(err));
          }
        })();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("completes the full OAuth flow and then lists the tools", async () => {
    // 1. Discover.
    const prm = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(prm.status).toBe(200);
    const prmBody = (await prm.json()) as { resource: string; authorization_servers: string[] };
    expect(prmBody.resource).toBe(`${baseUrl}/mcp`);

    // 2. Register a client.
    const registration = await fetch(`${baseUrl}/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        client_name: "e2e",
      }),
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    // 3. Authorize (the login form posts credentials back).
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const authorizeUrl = new URL(`${baseUrl}/oauth2/authorize`);
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "xyz");
    authorizeUrl.searchParams.set("resource", `${baseUrl}/mcp`);

    const login = await fetch(authorizeUrl, { redirect: "manual" });
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("Sign in to Helix");

    const loginPost = await fetch(authorizeUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "xyz",
        resource: `${baseUrl}/mcp`,
        email: "e2e@example.com",
        password: "hunter2",
      }).toString(),
    });
    expect(loginPost.status).toBe(302);
    const location = new URL(loginPost.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("iss")).toBe(baseUrl);
    const code = location.searchParams.get("code")!;

    // 4. Exchange the code.
    const tokenRes = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: verifier,
        resource: `${baseUrl}/mcp`,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };

    // 5. Call the MCP endpoint.
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokens.access_token}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(mcpRes.status).toBe(200);
    const body = (await mcpRes.json()) as {
      result: { resultType: string; tools: Array<{ name: string }>; ttlMs: number; cacheScope: string };
    };
    expect(body.result.resultType).toBe("complete");
    expect(body.result.ttlMs).toBeGreaterThan(0);
    expect(body.result.tools.map((t) => t.name)).toContain("generate_video");
  });

  it("rejects an MCP call without a token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});
