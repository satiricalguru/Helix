import { describe, expect, it } from "vitest";
import { createMcpApp } from "../src/http.js";
import { McpServer } from "../src/server.js";
import { TaskStore } from "../src/tasks.js";
import { buildTools } from "../src/tools.js";
import { InMemoryUserStore, OAuthServer, hashPassword } from "../src/oauth.js";
import { DEFAULT_HF_CATALOG } from "@helix/config";
import { InMemoryQuotaStore, QuotaService } from "@helix/quota";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
} from "@helix/contracts";

const ISSUER = "https://helix.example";
const RESOURCE = "https://helix.example/mcp";

function build() {
  const oauth = new OAuthServer({ issuer: ISSUER, resource: RESOURCE });
  const users = new InMemoryUserStore();
  const tools = buildTools({
    hf: undefined,
    catalog: DEFAULT_HF_CATALOG,
    quota: new QuotaService(new InMemoryQuotaStore()),
    dailyUsdBudget: 10,
  });
  const server = new McpServer({
    name: "helix",
    version: "0.1.0",
    instructions: "Helix generates images and video.",
    tools,
    tasks: new TaskStore(),
    enableTasks: true,
  });
  const app = createMcpApp({
    server,
    oauth,
    users,
    publicUrl: ISSUER,
    allowedOrigins: ["https://claude.ai"],
  });
  return { app, oauth, users };
}

const modernMeta = {
  [META_PROTOCOL_VERSION]: "2026-07-28",
  [META_CLIENT_INFO]: { name: "c", version: "1" },
  [META_CLIENT_CAPABILITIES]: {},
};

async function issueToken(oauth: OAuthServer, users: InMemoryUserStore): Promise<string> {
  const user = await users.create("a@example.com", hashPassword("hunter2"));
  const registration = oauth.registerClient({
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const redirect = await oauth.authorize({
    clientId: registration.client_id,
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    userId: user.id,
  });
  const code = new URL(redirect).searchParams.get("code")!;
  const tokens = (await oauth.token({
    grant_type: "authorization_code",
    code,
    client_id: registration.client_id,
    code_verifier: verifier,
  })) as Record<string, string>;
  return tokens.access_token!;
}

describe("MCP HTTP — well-known metadata", () => {
  it("serves the protected-resource metadata at both RFC 9728 paths", async () => {
    const { app } = build();
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resource: string; authorization_servers: string[] };
      expect(body.resource).toBe(RESOURCE);
      expect(body.authorization_servers).toEqual([ISSUER]);
    }
  });

  it("serves the authorization-server metadata", async () => {
    const { app } = build();
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string; registration_endpoint: string };
    expect(body.issuer).toBe(ISSUER);
    expect(body.registration_endpoint).toContain("/oauth2/register");
  });

  it("serves a JWKS", async () => {
    const { app } = build();
    const res = await app.request("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys.length).toBeGreaterThan(0);
  });
});

describe("MCP HTTP — dynamic registration", () => {
  it("registers a client", async () => {
    const { app } = build();
    const res = await app.request("/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    expect(body.client_id).toMatch(/^mcp_/);
  });
});

describe("MCP HTTP — authentication", () => {
  it("returns 401 with the WWW-Authenticate challenge when no token is sent", async () => {
    const { app } = build();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain("Bearer resource_metadata=");
    expect(challenge).toContain("oauth-protected-resource");
  });

  it("returns 401 for an invalid token", async () => {
    const { app } = build();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } }),
    });
    expect(res.status).toBe(401);
  });

  it("serves a request with a valid token", async () => {
    const { app, oauth, users } = build();
    const token = await issueToken(oauth, users);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools.length).toBeGreaterThan(0);
  });
});

describe("MCP HTTP — header validation", () => {
  async function post(headers: Record<string, string>) {
    const { app, oauth, users } = build();
    const token = await issueToken(oauth, users);
    return app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } }),
    });
  }

  it("rejects a protocol-version header that disagrees with _meta", async () => {
    const res = await post({ "mcp-protocol-version": "2025-11-25" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32020);
  });

  it("rejects an unsupported protocol version", async () => {
    const res = await post({ "mcp-protocol-version": "1999-01-01" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; data: { supported: string[] } } };
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain("2026-07-28");
  });

  it("rejects an Mcp-Method header that disagrees with the body", async () => {
    const res = await post({ "mcp-method": "tools/call", "mcp-protocol-version": "2026-07-28" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32020);
  });

  it("accepts a matching Mcp-Method header", async () => {
    const res = await post({ "mcp-method": "tools/list", "mcp-protocol-version": "2026-07-28" });
    expect(res.status).toBe(200);
  });
});

describe("MCP HTTP — origin validation", () => {
  it("rejects a disallowed origin with 403", async () => {
    const { app, oauth, users } = build();
    const token = await issueToken(oauth, users);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } }),
    });
    expect(res.status).toBe(403);
  });

  it("allows a listed origin", async () => {
    const { app, oauth, users } = build();
    const token = await issueToken(oauth, users);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        origin: "https://claude.ai",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } }),
    });
    expect(res.status).toBe(200);
  });
});

describe("MCP HTTP — unknown method", () => {
  it("returns 404 for an unknown RPC method", async () => {
    const { app, oauth, users } = build();
    const token = await issueToken(oauth, users);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope/nope", params: { _meta: modernMeta } }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it("returns 400 for a malformed body", async () => {
    const { app, oauth, users } = build();
    const token = await issueToken(oauth, users);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});


describe("MCP HTTP — the Higgsfield webhook", () => {
  const secret = "whsec_test";

  function buildWithWebhook() {
    const oauth = new OAuthServer({ issuer: ISSUER, resource: RESOURCE });
    const tools = buildTools({
      hf: undefined,
      catalog: DEFAULT_HF_CATALOG,
      quota: new QuotaService(new InMemoryQuotaStore()),
      dailyUsdBudget: 10,
    });
    const server = new McpServer({
      name: "helix",
      version: "0.1.0",
      instructions: "Helix generates images and video.",
      tools,
      tasks: new TaskStore(),
      enableTasks: true,
    });
    const app = createMcpApp({
      server,
      oauth,
      users: new InMemoryUserStore(),
      publicUrl: ISSUER,
      hf: {} as never,
      webhookSecret: secret,
    });
    return { app };
  }

  function signed(body: string, id: string, timestamp: string): string {
    return `v1,${createHmac("sha256", secret)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")}`;
  }

  it("accepts a correctly signed delivery", async () => {
    const { app } = buildWithWebhook();
    const body = JSON.stringify({ request_id: "req-1", status: "completed" });
    const id = "evt_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await app.request("/webhooks/higgsfield", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": signed(body, id, timestamp),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it("rejects an unsigned delivery", async () => {
    const { app } = buildWithWebhook();
    const res = await app.request("/webhooks/higgsfield", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "req-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a tampered body", async () => {
    const { app } = buildWithWebhook();
    const id = "evt_2";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await app.request("/webhooks/higgsfield", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": signed("{}", id, timestamp),
      },
      body: JSON.stringify({ request_id: "req-1", status: "completed" }),
    });
    expect(res.status).toBe(401);
  });

  it("deduplicates a retried delivery", async () => {
    const { app } = buildWithWebhook();
    const body = JSON.stringify({ request_id: "req-1", status: "completed" });
    const id = "evt_3";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signed(body, id, timestamp),
    };
    const first = await app.request("/webhooks/higgsfield", { method: "POST", headers, body });
    expect((await first.json()) as { duplicate?: boolean }).not.toHaveProperty("duplicate");
    const second = await app.request("/webhooks/higgsfield", { method: "POST", headers, body });
    expect((await second.json()) as { duplicate?: boolean }).toMatchObject({ duplicate: true });
  });

  it("reports that webhooks are not configured", async () => {
    const oauth = new OAuthServer({ issuer: ISSUER, resource: RESOURCE });
    const server = new McpServer({
      name: "helix",
      version: "0.1.0",
      instructions: "",
      tools: [],
      tasks: new TaskStore(),
    });
    const app = createMcpApp({
      server,
      oauth,
      users: new InMemoryUserStore(),
      publicUrl: ISSUER,
    });
    const res = await app.request("/webhooks/higgsfield", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(501);
  });
});

describe("MCP HTTP — the device flow", () => {
  it("reports that the device flow is not implemented", async () => {
    const { app } = build();
    const res = await app.request("/oauth2/device_authorization", { method: "POST" });
    expect(res.status).toBe(501);
  });
});

describe("MCP HTTP — the login flow", () => {
  it("shows a login form when there is no session", async () => {
    const { app } = build();
    const res = await app.request(
      "/oauth2/authorize?client_id=x&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=abc&code_challenge_method=S256&state=s1",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in to Helix");
    expect(html).toContain('name="email"');
    expect(html).toContain('name="code_challenge"');
  });

  it("signs in and redirects to the client with a code", async () => {
    const { app, oauth, users } = build();
    await users.create("a@example.com", hashPassword("hunter2"));
    const registration = oauth.registerClient({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    const res = await app.request("/oauth2/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: registration.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_challenge: "abc",
        code_challenge_method: "S256",
        state: "s1",
        email: "a@example.com",
        password: "hunter2",
      }).toString(),
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    const url = new URL(location);
    expect(url.searchParams.get("code")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("iss")).toBe(ISSUER);
    expect(res.headers.get("set-cookie")).toContain("helix_session");
  });

  it("rejects bad credentials", async () => {
    const { app, oauth, users } = build();
    await users.create("a@example.com", hashPassword("hunter2"));
    const registration = oauth.registerClient({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    const res = await app.request("/oauth2/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: registration.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_challenge: "abc",
        code_challenge_method: "S256",
        email: "a@example.com",
        password: "wrong",
      }).toString(),
    });
    expect(res.status).toBe(401);
  });
});
