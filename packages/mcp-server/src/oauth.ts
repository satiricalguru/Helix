/**
 * OAuth 2.1 authorization server and protected-resource metadata.
 *
 * Implements what Claude's connector client needs:
 *   - RFC 9728 protected-resource metadata (and the 401 challenge shape)
 *   - RFC 8414 authorization-server metadata
 *   - RFC 7591 dynamic client registration
 *   - RFC 8707 resource indicators (the `resource` parameter)
 *   - PKCE S256
 *   - RFC 9207 `iss` in the authorization response
 *   - refresh-token rotation for public clients
 */

import { createHash, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { SignJWT, jwtVerify, importJWK, exportJWK, generateKeyPair } from "jose";
import type {
  AuthorizationServerMetadata,
  DynamicClientRegistrationRequest,
  DynamicClientRegistrationResponse,
  ProtectedResourceMetadata,
} from "@helix/contracts";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

/* -------------------------------------------------------------- users */

export interface User {
  id: string;
  email: string;
  /** Password hash, as produced by `hashPassword`. */
  passwordHash: string;
}

export interface UserStore {
  findByEmail(email: string): Promise<User | undefined>;
  create(email: string, passwordHash: string): Promise<User>;
}

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const derived = pbkdf2(password, salt, 32);
  return `pbkdf2-sha256$100000$${salt.toString("base64url")}$${derived}`;
}

const PBKDF2_ITERATIONS = 100_000;

function pbkdf2(password: string, salt: Buffer, length: number): string {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, length, "sha256").toString("base64url");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const salt = Buffer.from(parts[2]!, "base64url");
  const expected = parts[3]!;
  const candidate = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64url");
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class InMemoryUserStore implements UserStore {
  #users = new Map<string, User>();

  async findByEmail(email: string): Promise<User | undefined> {
    return this.#users.get(email.toLowerCase());
  }

  async create(email: string, passwordHash: string): Promise<User> {
    const user: User = { id: randomUUID(), email: email.toLowerCase(), passwordHash };
    this.#users.set(user.email, user);
    return user;
  }
}

/**
 * A user store backed by a JSON file.
 *
 * Accounts survive restarts, which matters because the MCP OAuth flow needs a
 * real, persistent identity. The file holds password hashes only.
 */
export class JsonFileUserStore implements UserStore {
  #path: string;
  #users = new Map<string, User>();

  private constructor(path: string, users: User[]) {
    this.#path = path;
    for (const u of users) this.#users.set(u.email, u);
  }

  /** Load the store, creating the file if it does not exist. */
  static async open(path: string): Promise<JsonFileUserStore> {
    let users: User[] = [];
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) users = parsed as User[];
    } catch {
      // A missing or unreadable file starts an empty store.
    }
    return new JsonFileUserStore(path, users);
  }

  async findByEmail(email: string): Promise<User | undefined> {
    return this.#users.get(email.toLowerCase());
  }

  async create(email: string, passwordHash: string): Promise<User> {
    const user: User = { id: randomUUID(), email: email.toLowerCase(), passwordHash };
    this.#users.set(user.email, user);
    await this.#flush();
    return user;
  }

  async #flush(): Promise<void> {
    const users = [...this.#users.values()];
    await writeFile(this.#path, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
  }
}

/* ------------------------------------------------------------ clients */

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  scope?: string;
  clientName?: string;
  createdAt: number;
}

export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource?: string;
  expiresAt: number;
}

export interface RefreshTokenRecord {
  token: string;
  clientId: string;
  userId: string;
  scope: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenClaims {
  sub: string;
  iss: string;
  aud: string;
  scope: string;
  exp: number;
  iat: number;
  jti: string;
  client_id: string;
}

export interface OAuthOptions {
  /** The AS issuer, e.g. "https://helix.example". No trailing slash. */
  issuer: string;
  /** The canonical MCP resource URL, e.g. "https://helix.example/mcp". */
  resource: string;
  scopes?: string[];
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  /** Extra redirect URIs to accept, beyond the built-in Claude ones. */
  extraRedirectUris?: string[];
}

/** Redirect URIs Claude uses, per the connector documentation. */
export const CLAUDE_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "http://localhost:3118/callback",
  "http://127.0.0.1/callback",
];

export class OAuthServer {
  #opts: Required<Omit<OAuthOptions, "extraRedirectUris">> & { extraRedirectUris: string[] };
  #clients = new Map<string, RegisteredClient>();
  #codes = new Map<string, AuthorizationCode>();
  #refreshTokens = new Map<string, RefreshTokenRecord>();
  #privateKey!: KeyPair["privateKey"];
  #publicKey!: KeyPair["publicKey"];
  #keyId: string;
  #ready: Promise<void>;

  constructor(opts: OAuthOptions) {
    this.#opts = {
      issuer: opts.issuer.replace(/\/$/, ""),
      resource: opts.resource,
      scopes: opts.scopes ?? ["mcp:tools", "mcp:read", "profile", "email", "offline_access"],
      accessTokenTtlSeconds: opts.accessTokenTtlSeconds ?? 600,
      refreshTokenTtlSeconds: opts.refreshTokenTtlSeconds ?? 30 * 24 * 3600,
      extraRedirectUris: opts.extraRedirectUris ?? [],
    };
    this.#keyId = randomUUID();
    this.#ready = generateKeyPair("RS256").then(({ privateKey, publicKey }) => {
      this.#privateKey = privateKey;
      this.#publicKey = publicKey;
    });
  }

  get issuer(): string {
    return this.#opts.issuer;
  }

  get resource(): string {
    return this.#opts.resource;
  }

  /** True when the redirect URI is acceptable for this client. */
  #redirectAllowed(client: RegisteredClient, redirectUri: string): boolean {
    if (client.redirectUris.includes(redirectUri)) return true;
    // Claude Code uses a loopback URI with an arbitrary port.
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+\/callback$/.test(redirectUri)) return true;
    if (/^http:\/\/(localhost|127\.0\.0\.1)\/callback$/.test(redirectUri)) return true;
    return false;
  }

  /* ------------------------------------------------------- metadata */

  protectedResourceMetadata(): ProtectedResourceMetadata {
    return {
      resource: this.#opts.resource,
      authorization_servers: [this.#opts.issuer],
      scopes_supported: this.#opts.scopes,
      bearer_methods_supported: ["header"],
    };
  }

  authorizationServerMetadata(): AuthorizationServerMetadata {
    const base = this.#opts.issuer;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth2/authorize`,
      token_endpoint: `${base}/oauth2/token`,
      registration_endpoint: `${base}/oauth2/register`,
      revocation_endpoint: `${base}/oauth2/revoke`,
      device_authorization_endpoint: `${base}/oauth2/device_authorization`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      response_modes_supported: ["form_post", "query"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: this.#opts.scopes,
    };
  }

  async jwks(): Promise<{ keys: unknown[] }> {
    await this.#ready;
    const jwk = await exportJWK(this.#publicKey);
    return { keys: [{ ...jwk, kid: this.#keyId, use: "sig", alg: "RS256" }] };
  }

  /* --------------------------------------------------- registration */

  registerClient(request: DynamicClientRegistrationRequest): DynamicClientRegistrationResponse {
    const clientId = `mcp_${randomBytes(16).toString("base64url")}`;
    const redirectUris = request.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      throw new OAuthError("invalid_request", "redirect_uris is required");
    }
    const client: RegisteredClient = {
      clientId,
      redirectUris,
      grantTypes: request.grant_types ?? ["authorization_code", "refresh_token"],
      responseTypes: request.response_types ?? ["code"],
      tokenEndpointAuthMethod: request.token_endpoint_auth_method ?? "none",
      ...(request.scope ? { scope: request.scope } : {}),
      ...(request.client_name ? { clientName: request.client_name } : {}),
      createdAt: Date.now(),
    };
    this.#clients.set(clientId, client);
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      ...(client.scope ? { scope: client.scope } : {}),
    };
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.#clients.get(clientId);
  }

  /* ------------------------------------------------------ authorize */

  /**
   * Validate an authorization request and mint a code.
   *
   * @returns the redirect URL to send the user to, including `code`, `state`
   *          and `iss` (RFC 9207).
   */
  async authorize(params: {
    clientId: string;
    redirectUri: string;
    state?: string;
    scope?: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    resource?: string;
    userId: string;
  }): Promise<string> {
    const client = this.#clients.get(params.clientId);
    if (!client) {
      throw new OAuthError("invalid_request", "Unknown client_id.");
    }
    if (!this.#redirectAllowed(client, params.redirectUri)) {
      throw new OAuthError("invalid_request", "redirect_uri is not registered for this client.");
    }
    if (params.codeChallengeMethod !== "S256") {
      throw new OAuthError("invalid_request", "Only PKCE with S256 is supported.");
    }
    if (!params.codeChallenge) {
      throw new OAuthError("invalid_request", "code_challenge is required.");
    }
    if (params.resource && params.resource !== this.#opts.resource) {
      throw new OAuthError("invalid_target", "The resource parameter does not match this server.");
    }

    const code = randomBytes(32).toString("base64url");
    this.#codes.set(code, {
      code,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      userId: params.userId,
      scope: params.scope ?? this.#opts.scopes.join(" "),
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      ...(params.resource ? { resource: params.resource } : {}),
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state) url.searchParams.set("state", params.state);
    // RFC 9207: the client must validate the issuer.
    url.searchParams.set("iss", this.#opts.issuer);
    return url.toString();
  }

  /* ---------------------------------------------------------- token */

  async token(body: Record<string, string>): Promise<Record<string, unknown>> {
    const grantType = body.grant_type;
    if (grantType === "authorization_code") {
      return this.#tokenFromCode(body);
    }
    if (grantType === "refresh_token") {
      return this.#tokenFromRefresh(body);
    }
    throw new OAuthError("unsupported_grant_type", `Unsupported grant_type: ${grantType ?? "(none)"}`);
  }

  async #tokenFromCode(body: Record<string, string>): Promise<Record<string, unknown>> {
    const code = body.code;
    const record = code ? this.#codes.get(code) : undefined;
    if (!record) throw new OAuthError("invalid_grant", "Unknown or already-used authorization code.");
    if (record.expiresAt < Date.now()) {
      this.#codes.delete(record.code);
      throw new OAuthError("invalid_grant", "The authorization code has expired.");
    }
    // A code is single-use.
    this.#codes.delete(record.code);

    const client = this.#clients.get(record.clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client.");

    if (body.client_id && body.client_id !== client.clientId) {
      throw new OAuthError("invalid_grant", "The code was issued to a different client.");
    }
    if (body.redirect_uri && body.redirect_uri !== record.redirectUri) {
      throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (body.resource && body.resource !== this.#opts.resource) {
      throw new OAuthError("invalid_target", "The resource parameter does not match this server.");
    }

    // PKCE: the verifier must hash to the challenge.
    const verifier = body.code_verifier;
    if (!verifier) throw new OAuthError("invalid_grant", "code_verifier is required.");
    const challenge = base64UrlSha256(verifier);
    if (!safeEqual(challenge, record.codeChallenge)) {
      throw new OAuthError("invalid_grant", "The code verifier does not match the code challenge.");
    }

    return this.#issueTokens(client, record.userId, record.scope, record.resource);
  }

  async #tokenFromRefresh(body: Record<string, string>): Promise<Record<string, unknown>> {
    const presented = body.refresh_token;
    const record = presented ? this.#refreshTokens.get(presented) : undefined;
    if (!record) {
      // A refresh token that is not recognised is dead: say invalid_grant,
      // not invalid_request, so clients know to re-authorize.
      throw new OAuthError("invalid_grant", "The refresh token is invalid or has been revoked.");
    }
    if (record.expiresAt < Date.now()) {
      this.#refreshTokens.delete(record.token);
      throw new OAuthError("invalid_grant", "The refresh token has expired.");
    }
    const client = this.#clients.get(record.clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client.");
    if (body.client_id && body.client_id !== client.clientId) {
      throw new OAuthError("invalid_grant", "The refresh token was issued to a different client.");
    }
    if (body.resource && body.resource !== this.#opts.resource) {
      throw new OAuthError("invalid_target", "The resource parameter does not match this server.");
    }

    // Rotate: the old refresh token is single-use.
    this.#refreshTokens.delete(record.token);
    return this.#issueTokens(client, record.userId, record.scope, record.resource);
  }

  async #issueTokens(
    client: RegisteredClient,
    userId: string,
    scope: string,
    resource: string | undefined,
  ): Promise<Record<string, unknown>> {
    await this.#ready;
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = this.#opts.accessTokenTtlSeconds;
    const claims: TokenClaims = {
      sub: userId,
      iss: this.#opts.issuer,
      aud: this.#opts.resource,
      scope,
      exp: now + expiresIn,
      iat: now,
      jti: randomUUID(),
      client_id: client.clientId,
    };
    const accessToken = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "RS256", kid: this.#keyId, typ: "at+jwt" })
      .setIssuedAt(now)
      .setExpirationTime(now + expiresIn)
      .setIssuer(this.#opts.issuer)
      .setAudience(this.#opts.resource)
      .setSubject(userId)
      .setJti(claims.jti)
      .sign(this.#privateKey);

    const refreshToken = randomBytes(32).toString("base64url");
    this.#refreshTokens.set(refreshToken, {
      token: refreshToken,
      clientId: client.clientId,
      userId,
      scope,
      ...(resource ? { resource } : {}),
      expiresAt: Date.now() + this.#opts.refreshTokenTtlSeconds * 1000,
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope,
    };
  }

  /** Revoke a refresh token (or an access token, which is stateless). */
  revoke(body: Record<string, string>): void {
    const token = body.token;
    if (token) this.#refreshTokens.delete(token);
  }

  /** Verify a bearer token. Returns undefined when it is not usable here. */
  async verifyAccessToken(token: string): Promise<TokenClaims | undefined> {
    await this.#ready;
    try {
      const jwk = await exportJWK(this.#publicKey);
      const key = await importJWK({ ...jwk, kid: this.#keyId, alg: "RS256" }, "RS256");
      const { payload } = await jwtVerify(token, key, {
        issuer: this.#opts.issuer,
        audience: this.#opts.resource,
      });
      return payload as unknown as TokenClaims;
    } catch {
      return undefined;
    }
  }

  /** The `WWW-Authenticate` challenge Claude expects on a 401. */
  challenge(scope?: string): string {
    const parts = [
      `Bearer resource_metadata="${this.#opts.issuer}/.well-known/oauth-protected-resource"`,
    ];
    if (scope) parts.push(`scope="${scope}"`);
    return parts.join(", ");
  }
}

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }

  toBody(): Record<string, unknown> {
    return { error: this.code, error_description: this.message };
  }
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value, "ascii").digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export { importJWK, exportJWK };
