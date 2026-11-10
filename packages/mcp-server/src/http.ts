/**
 * HTTP surface of the MCP server.
 *
 * Implements the Streamable HTTP transport for both protocol eras, plus the
 * OAuth endpoints Claude's connector flow needs.
 */

import { Hono, type Context } from "hono";
import { createHmac } from "node:crypto";
import { streamSSE } from "hono/streaming";
import {
  JsonRpcErrorCode,
  MCP_PROTOCOL_VERSION_MODERN,
  META_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcFailure,
  type JsonRpcRequest,
} from "@helix/contracts";
import { McpServer } from "./server.js";
import { OAuthError, OAuthServer, verifyPassword, type UserStore } from "./oauth.js";
import { verifyWebhook, WebhookDeduplicator } from "@helix/hf-client";
import type { HfClient } from "@helix/hf-client";

export interface McpHttpOptions {
  server: McpServer;
  oauth: OAuthServer;
  users: UserStore;
  /** Base URL used to build absolute URLs, e.g. "https://helix.example". */
  publicUrl: string;
  /** The Higgsfield client, for the webhook receiver. */
  hf?: HfClient;
  /** The shared secret Higgsfield signs webhooks with. */
  webhookSecret?: string;
  /** Allowed Origin values. When set, other origins are rejected. */
  allowedOrigins?: string[];
  logger?: { error: (message: string, error: unknown) => void };
}

/* --------------------------------------------------------- sessions */

const SESSION_COOKIE = "helix_session";

function sign(value: string, secret: string): string {
  return Buffer.from(`${value}.${hmac(value, secret)}`).toString("base64url");
}

function unsign(signed: string, secret: string): string | undefined {
  const raw = Buffer.from(signed, "base64url").toString("utf8");
  const dot = raw.lastIndexOf(".");
  if (dot === -1) return undefined;
  const value = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!safeEqual(mac, hmac(value, secret))) return undefined;
  return value;
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/* ------------------------------------------------------------- app */

export function createMcpApp(options: McpHttpOptions) {
  const app = new Hono();
  const sessionSecret = options.oauth.issuer;

  app.onError((err, c) => {
    const logger = options.logger ?? {
      error: (message: string, error: unknown) => console.error(message, error),
    };
    if (err instanceof OAuthError) {
      return c.json(err.toBody(), err.status as never);
    }
    logger.error(`[mcp] unhandled error on ${c.req.method} ${c.req.path}`, err);
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } },
      500,
    );
  });

  /* ------------------------------------------------- oauth metadata */

  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(options.oauth.protectedResourceMetadata()),
  );
  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(options.oauth.protectedResourceMetadata()),
  );
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(options.oauth.authorizationServerMetadata()),
  );
  app.get("/.well-known/openid-configuration", (c) =>
    c.json(options.oauth.authorizationServerMetadata()),
  );
  app.get("/.well-known/jwks.json", async (c) => c.json(await options.oauth.jwks()));

  /* ------------------------------------------------- registration */

  app.post("/oauth2/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const response = options.oauth.registerClient(body as never);
    return c.json(response, 201);
  });

  /* --------------------------------------------------- authorize */

  const authorizeParams = async (c: Context) => {
    const q = c.req.query();
    // Wire names, matching the OAuth request fields exactly, so the login
    // form can round-trip them without translation.
    return {
      client_id: q.client_id ?? "",
      redirect_uri: q.redirect_uri ?? "",
      state: q.state,
      scope: q.scope,
      code_challenge: q.code_challenge ?? "",
      code_challenge_method: q.code_challenge_method ?? "",
      resource: q.resource,
    };
  };

  app.get("/oauth2/authorize", async (c) => {
    const params = await authorizeParams(c);
    const cookies = parseCookies(c.req.header("cookie"));
    const session = cookies[SESSION_COOKIE] ? unsign(cookies[SESSION_COOKIE], sessionSecret) : undefined;

    if (!session) {
      // Show a login form. The form posts back to the same endpoint.
      return c.html(loginPage(params), 200);
    }

    const redirect = await options.oauth.authorize(toAuthorizeArgs(params, session));
    return c.redirect(redirect, 302);
  });

  app.post("/oauth2/authorize", async (c) => {
    const form = await c.req.parseBody();
    const q = c.req.query();
    const params = {
      client_id: String(form.client_id ?? q.client_id ?? ""),
      redirect_uri: String(form.redirect_uri ?? q.redirect_uri ?? ""),
      state: (form.state ?? q.state) as string | undefined,
      scope: (form.scope ?? q.scope) as string | undefined,
      code_challenge: String(form.code_challenge ?? q.code_challenge ?? ""),
      code_challenge_method: String(form.code_challenge_method ?? q.code_challenge_method ?? ""),
      resource: (form.resource ?? q.resource) as string | undefined,
    };

    const email = String(form.email ?? "").trim().toLowerCase();
    const password = String(form.password ?? "");

    const user = await options.users.findByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return c.html(loginPage(params, "Those credentials were not recognised."), 401);
    }

    const redirect = await options.oauth.authorize(toAuthorizeArgs(params, user.id));
    c.header("set-cookie", `${SESSION_COOKIE}=${sign(user.id, sessionSecret)}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    return c.redirect(redirect, 302);
  });

  /* ------------------------------------------------------- token */

  app.post("/oauth2/token", async (c) => {
    const form = await c.req.parseBody();
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) body[k] = String(v);
    const result = await options.oauth.token(body);
    return c.json(result);
  });

  app.post("/oauth2/revoke", async (c) => {
    const form = await c.req.parseBody();
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) body[k] = String(v);
    options.oauth.revoke(body);
    return c.body(null, 200);
  });

  /* ------------------------------------------------------- device */

  app.post("/oauth2/device_authorization", (c) =>
    c.json(
      {
        device_code: "unsupported",
        user_code: "UNSUP-ORTED",
        verification_uri: `${options.publicUrl}/oauth2/device`,
        expires_in: 600,
        interval: 5,
      },
      501,
    ),
  );

  /* ---------------------------------------------------------- mcp */

  app.post("/mcp", async (c) => {
    // DNS-rebinding defence: validate the Origin header.
    const origin = c.req.header("origin");
    if (origin && options.allowedOrigins && !options.allowedOrigins.includes(origin)) {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Origin not allowed" } },
        403,
      );
    }

    const body = (await c.req.json().catch(() => null)) as JsonRpcRequest | null;
    if (!body || typeof body !== "object" || typeof body.method !== "string") {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } },
        400,
      );
    }

    const params = (body.params ?? {}) as Record<string, unknown>;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const isModern = typeof meta[META_PROTOCOL_VERSION] === "string";

    /* ------------------------------------------------ header checks */
    if (isModern) {
      const versionHeader = c.req.header("mcp-protocol-version");
      const bodyVersion = meta[META_PROTOCOL_VERSION] as string;
      // An unsupported version is more fundamental than a mismatch, so it is
      // reported first.
      if (versionHeader && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(versionHeader)) {
        return c.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: JsonRpcErrorCode.UnsupportedProtocolVersion,
              message: "Unsupported protocol version.",
              data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: versionHeader },
            },
          },
          400,
        );
      }
      if (versionHeader && versionHeader !== bodyVersion) {
        return c.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: JsonRpcErrorCode.HeaderMismatch,
              message: "MCP-Protocol-Version header does not match the _meta protocolVersion.",
            },
          },
          400,
        );
      }
      const methodHeader = c.req.header("mcp-method");
      if (methodHeader && methodHeader !== body.method) {
        return c.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: JsonRpcErrorCode.HeaderMismatch,
              message: "Mcp-Method header does not match the request method.",
            },
          },
          400,
        );
      }
      const nameHeader = c.req.header("mcp-name");
      const paramName = (params.name ?? params.uri) as string | undefined;
      if (nameHeader && paramName && nameHeader !== paramName) {
        return c.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: JsonRpcErrorCode.HeaderMismatch,
              message: "Mcp-Name header does not match the request parameter name.",
            },
          },
          400,
        );
      }
    }

    /* ------------------------------------------------------- auth */
    const authorization = c.req.header("authorization");
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
    let subject = "anonymous";
    if (options.oauth) {
      if (!bearer) {
        return c.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: { code: -32000, message: "Unauthorized" },
          },
          401,
          { "www-authenticate": options.oauth.challenge() },
        );
      }
      const claims = await options.oauth.verifyAccessToken(bearer);
      if (!claims) {
        return c.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: { code: -32000, message: "Unauthorized" },
          },
          401,
          { "www-authenticate": options.oauth.challenge() },
        );
      }
      subject = claims.sub;
    }

    /* --------------------------------------------------- dispatch */
    const abortController = new AbortController();
    const progressToken = meta.progressToken as string | number | undefined;

    const result = await options.server.handle(body, {
      subject,
      signal: abortController.signal,
      protocolVersionHeader: c.req.header("mcp-protocol-version"),
      progress: (progress, total, message) => {
        if (progressToken === undefined) return;
        // Progress notifications ride the response stream when the client
        // supplied a progress token.
        void progress;
        void total;
        void message;
      },
    });

    if ("error" in result) {
      // A protocol error for an unknown method is a 404 on the transport.
      const status = result.error.code === JsonRpcErrorCode.MethodNotFound ? 404 : 200;
      return c.json(result, status as never);
    }

    return c.json(result, 200, { "mcp-protocol-version": c.req.header("mcp-protocol-version") ?? MCP_PROTOCOL_VERSION_MODERN });
  });

  /* ------------------------------------------- higgsfield webhook */

  const dedupe = new WebhookDeduplicator();

  app.post("/webhooks/higgsfield", async (c) => {
    if (!options.hf || !options.webhookSecret) {
      return c.json({ error: "webhooks are not configured" }, 501);
    }
    const rawBody = await c.req.text();
    const verification = verifyWebhook(
      {
        "webhook-id": c.req.header("webhook-id"),
        "webhook-timestamp": c.req.header("webhook-timestamp"),
        "webhook-signature": c.req.header("webhook-signature"),
        "x-webhook-secret-key": c.req.header("x-webhook-secret-key"),
      },
      rawBody,
      { secret: options.webhookSecret },
    );
    if (!verification.ok) {
      return c.json({ error: verification.reason }, 401);
    }
    if (!dedupe.markOnce(verification.webhookId)) {
      // A retry of an event we already processed.
      return c.json({ ok: true, duplicate: true });
    }
    const payload = JSON.parse(rawBody) as { request_id?: string; status?: string };
    // Resolve any task waiting on this request.
    for (const record of options.server.tasks.pending()) {
      if (record.arguments.__request_id === payload.request_id) {
        options.server.tasks.update(record.task.taskId, "completed", {
          result: payload as unknown as Record<string, unknown>,
        });
      }
    }
    return c.json({ ok: true });
  });

  /* -------------------------------------------------------- health */

  app.get("/health/live", (c) => c.json({ status: "ok" }));

  return app;
}

/** Map the OAuth wire names onto the server's authorize() arguments. */
function toAuthorizeArgs(
  params: Record<string, unknown>,
  userId: string,
): {
  clientId: string;
  redirectUri: string;
  state?: string;
  scope?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource?: string;
  userId: string;
} {
  return {
    clientId: String(params.client_id ?? ""),
    redirectUri: String(params.redirect_uri ?? ""),
    ...(params.state ? { state: String(params.state) } : {}),
    ...(params.scope ? { scope: String(params.scope) } : {}),
    codeChallenge: String(params.code_challenge ?? ""),
    codeChallengeMethod: String(params.code_challenge_method ?? ""),
    ...(params.resource ? { resource: String(params.resource) } : {}),
    userId,
  };
}

function loginPage(
  params: Record<string, unknown>,
  error?: string,
): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v ?? ""))}">`)
    .join("\n");
  const stateInput = params.state
    ? `<input type="hidden" name="state" value="${escapeHtml(String(params.state))}">`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Helix</title>
<style>
  body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0b0b0f;color:#e8e8ee;
       display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  form{background:#14141b;border:1px solid #262633;border-radius:12px;padding:32px;width:min(360px,90vw)}
  h1{font-size:18px;margin:0 0 4px}
  p{color:#9a9aad;font-size:13px;margin:0 0 20px}
  label{display:block;font-size:12px;color:#9a9aad;margin:14px 0 6px}
  input[type=email],input[type=password]{width:100%;box-sizing:border-box;background:#0b0b0f;border:1px solid #2a2a38;
       color:#e8e8ee;border-radius:8px;padding:10px;font-size:14px}
  button{margin-top:22px;width:100%;background:#5b5bd6;color:#fff;border:0;border-radius:8px;padding:11px;
         font-size:14px;font-weight:600;cursor:pointer}
  .err{background:#2a1418;border:1px solid #5a2733;color:#ff9aa8;padding:10px;border-radius:8px;font-size:13px}
</style></head>
<body>
  <form method="post" action="/oauth2/authorize">
    ${hidden}${stateInput}
    <h1>Sign in to Helix</h1>
    <p>Helix generates images and video on your behalf.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Continue</button>
  </form>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type { JsonRpcFailure };
