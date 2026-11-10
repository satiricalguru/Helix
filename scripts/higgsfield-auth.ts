/**
 * Obtain an access token for the real Higgsfield MCP server.
 *
 * Higgsfield's MCP server (https://mcp.higgsfield.ai/mcp) is an OAuth 2.1
 * protected resource served by https://clerk.higgsfield.ai. Its advertised
 * device-authorization grant is not actually enabled, so this script uses the
 * authorization-code flow with PKCE and a loopback callback — the same shape
 * as `claude mcp login`.
 *
 *   pnpm tsx scripts/higgsfield-auth.ts
 *
 * It opens your browser to Higgsfield's sign-in. After you approve, the
 * token is cached in ~/.config/helix/higgsfield-token.json and refreshed
 * automatically on expiry.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

const MCP_URL = "https://mcp.higgsfield.ai/mcp";
const TOKEN_FILE = path.join(homedir(), ".config", "helix", "higgsfield-token.json");
const CALLBACK_PORT = 3118;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

interface TokenFile {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  client_id: string;
}

async function readToken(): Promise<TokenFile | undefined> {
  try {
    return JSON.parse(await readFile(TOKEN_FILE, "utf8")) as TokenFile;
  } catch {
    return undefined;
  }
}

async function writeToken(token: TokenFile): Promise<void> {
  await mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await writeFile(TOKEN_FILE, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

/** The issuer that protects the MCP server. */
async function discoverIssuer(): Promise<string> {
  const res = await fetch("https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp");
  if (!res.ok) throw new Error(`could not read the protected-resource metadata: HTTP ${res.status}`);
  const body = (await res.json()) as { authorization_servers?: string[] };
  const issuer = body.authorization_servers?.[0];
  if (!issuer) throw new Error("the server did not advertise an authorization server");
  return issuer;
}

/** Register a client bound to the loopback callback. */
export async function registerClient(issuer: string): Promise<string> {
  const res = await fetch(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Helix CLI",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`client registration failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) throw new Error("the server did not return a client_id");
  return body.client_id;
}

/** Refresh the cached token when it is close to expiry. */
async function refreshIfNeeded(token: TokenFile, issuer: string): Promise<TokenFile> {
  if (token.expires_at - Date.now() > 5 * 60 * 1000) return token;
  if (!token.refresh_token) return token;
  const res = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: token.client_id,
    }).toString(),
  });
  if (!res.ok) return token;
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const next: TokenFile = {
    access_token: body.access_token,
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    expires_at: Date.now() + body.expires_in * 1000,
    client_id: token.client_id,
  };
  await writeToken(next);
  return next;
}

/**
 * Run the browser redirect flow and wait for the callback.
 *
 * The callback listener binds to 127.0.0.1 only.
 */
async function authorizeInBrowser(
  issuer: string,
  clientId: string,
  verifier: string,
): Promise<string> {
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const url = new URL(`${issuer}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email offline_access");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", MCP_URL);

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", REDIRECT_URI);
      if (requestUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end();
        return;
      }
      const returnedState = requestUrl.searchParams.get("state");
      if (returnedState !== state) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end("<h1>State mismatch</h1><p>The sign-in could not be verified.</p>");
        reject(new Error("the state parameter did not match"));
        server.close();
        return;
      }
      const authorizationError = requestUrl.searchParams.get("error");
      if (authorizationError) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(`<h1>Sign-in failed</h1><p>${authorizationError}</p>`);
        reject(new Error(`the authorization server returned ${authorizationError}`));
        server.close();
        return;
      }
      const authorizationCode = requestUrl.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<h1>Helix is authorised</h1><p>You can close this tab and return to the terminal.</p>",
      );
      server.close();
      if (!authorizationCode) {
        reject(new Error("the callback carried no authorization code"));
        return;
      }
      resolve(authorizationCode);
    });
    server.on("error", (err) => reject(err));
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      console.log("\n  Authorise Helix with Higgsfield:\n");
      console.log(`    ${url.toString()}\n`);
      console.log("    Opening your browser. Approve the request, then come back here.");
      console.log("    (If the browser did not open, paste the URL above.)\n");
      void openBrowser(url.toString());
    });
  });

  return code;
}

/** Best-effort browser launch. */
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is printed, so the user can open it manually.
  }
}

/** The cached access token, refreshing it if needed. */
export async function getHiggsfieldToken(): Promise<string> {
  const issuer = await discoverIssuer();
  const existing = await readToken();
  if (existing) {
    const refreshed = await refreshIfNeeded(existing, issuer);
    return refreshed.access_token;
  }

  const clientId = await registerClient(issuer);
  const verifier = randomBytes(32).toString("base64url");
  const code = await authorizeInBrowser(issuer, clientId, verifier);

  const res = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: MCP_URL,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`the token request failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const token: TokenFile = {
    access_token: body.access_token,
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    expires_at: Date.now() + body.expires_in * 1000,
    client_id: clientId,
  };
  await writeToken(token);
  return token.access_token;
}

async function main(): Promise<void> {
  const issuer = await discoverIssuer();
  console.log(`[higgsfield] authorization server: ${issuer}`);

  const existing = await readToken();
  if (existing) {
    const refreshed = await refreshIfNeeded(existing, issuer);
    if (refreshed.access_token === existing.access_token) {
      console.log("[higgsfield] a cached token is still valid.");
      console.log(`[higgsfield] ${TOKEN_FILE}`);
      return;
    }
    console.log("[higgsfield] refreshed the cached token.");
    return;
  }

  const token = await getHiggsfieldToken();
  console.log(`\n[higgsfield] authorised. Token cached at ${TOKEN_FILE}`);
  console.log(`[higgsfield] token starts with ${token.slice(0, 12)}...`);
}

const isMain = process.argv[1]?.endsWith("higgsfield-auth.ts");
if (isMain) {
  main().catch((err) => {
    console.error(`\n[higgsfield] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
