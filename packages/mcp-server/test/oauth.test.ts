import { describe, expect, it } from "vitest";
import {
  base64UrlSha256,
  hashPassword,
  InMemoryUserStore,
  OAuthError,
  OAuthServer,
  verifyPassword,
} from "../src/oauth.js";
import { createHash, randomBytes } from "node:crypto";

const ISSUER = "https://helix.example";
const RESOURCE = "https://helix.example/mcp";

function server(overrides: Partial<ConstructorParameters<typeof OAuthServer>[0]> = {}) {
  return new OAuthServer({ issuer: ISSUER, resource: RESOURCE, ...overrides });
}

describe("password hashing", () => {
  it("round-trips a password", () => {
    const stored = hashPassword("correct horse");
    expect(verifyPassword("correct horse", stored)).toBe(true);
    expect(verifyPassword("wrong horse", stored)).toBe(false);
  });

  it("salts each hash", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects a malformed stored hash", () => {
    expect(verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("metadata documents", () => {
  it("publishes protected-resource metadata at the RFC 9728 path", () => {
    const prm = server().protectedResourceMetadata();
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toEqual([ISSUER]);
    expect(prm.bearer_methods_supported).toEqual(["header"]);
  });

  it("publishes authorization-server metadata with DCR, CIMD and iss support", () => {
    const meta = server().authorizationServerMetadata();
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
    expect(meta.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.grant_types_supported).toContain("refresh_token");
  });

  it("builds a challenge Claude recognises", () => {
    const challenge = server().challenge("mcp:tools");
    expect(challenge).toContain("Bearer resource_metadata=");
    expect(challenge).toContain('/.well-known/oauth-protected-resource"');
    expect(challenge).toContain('scope="mcp:tools"');
  });
});

describe("dynamic client registration", () => {
  it("registers a client and returns its id", () => {
    const response = server().registerClient({
      redirect_uris: ["http://localhost:3118/callback"],
      application_type: "native",
    });
    expect(response.client_id).toMatch(/^mcp_/);
    expect(response.redirect_uris).toEqual(["http://localhost:3118/callback"]);
    expect(response.token_endpoint_auth_method).toBe("none");
  });

  it("rejects a registration with no redirect uris", () => {
    expect(() => server().registerClient({ redirect_uris: [] })).toThrow(OAuthError);
  });
});

describe("authorization code flow", () => {
  it("rejects a redirect_uri that is not registered", async () => {
    const oauth = server();
    const registration = oauth.registerClient({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    await expect(
      oauth.authorize({
        clientId: registration.client_id,
        redirectUri: "https://evil.example/callback",
        codeChallenge: base64UrlSha256("v"),
        codeChallengeMethod: "S256",
        userId: "u",
      }),
    ).rejects.toThrow(/redirect_uri is not registered/);
  });

  it("rejects a non-S256 code challenge", async () => {
    const oauth = server();
    const registration = oauth.registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    await expect(
      oauth.authorize({
        clientId: registration.client_id,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeChallenge: "abc",
        codeChallengeMethod: "plain",
        userId: "u",
      }),
    ).rejects.toThrow(/S256/);
  });

  it("rejects a mismatched resource parameter", async () => {
    const oauth = server();
    const registration = oauth.registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    await expect(
      oauth.authorize({
        clientId: registration.client_id,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeChallenge: base64UrlSha256("v"),
        codeChallengeMethod: "S256",
        resource: "https://other.example/mcp",
        userId: "u",
      }),
    ).rejects.toThrow(/resource parameter/);
  });
});

describe("token endpoint", () => {
  async function authorize(oauth: OAuthServer, redirectUri = "https://claude.ai/api/mcp/auth_callback") {
    const registration = oauth.registerClient({ redirect_uris: [redirectUri] });
    const verifier = randomBytes(32).toString("base64url");
    const challenge = base64UrlSha256(verifier);
    const redirect = await oauth.authorize({
      clientId: registration.client_id,
      redirectUri,
      state: "s1",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      userId: "user-1",
    });
    const url = new URL(redirect);
    return {
      registration,
      verifier,
      code: url.searchParams.get("code")!,
      state: url.searchParams.get("state")!,
      iss: url.searchParams.get("iss")!,
    };
  }

  it("exchanges a code for tokens", async () => {
    const oauth = server();
    const { registration, verifier, code } = await authorize(oauth);
    const tokens = (await oauth.token({
      grant_type: "authorization_code",
      code,
      client_id: registration.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_verifier: verifier,
    })) as Record<string, string>;
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.refresh_token).toBeTruthy();
    expect(Number(tokens.expires_in)).toBeGreaterThan(0);
  });

  it("includes the state and iss in the authorization redirect", async () => {
    const oauth = server();
    const { state, iss } = await authorize(oauth);
    expect(state).toBe("s1");
    expect(iss).toBe(ISSUER);
  });

  it("rejects a wrong code verifier", async () => {
    const oauth = server();
    const { registration, code } = await authorize(oauth);
    await expect(
      oauth.token({
        grant_type: "authorization_code",
        code,
        client_id: registration.client_id,
        code_verifier: "wrong-verifier",
      }),
    ).rejects.toThrow(/code verifier/);
  });

  it("treats a code as single-use", async () => {
    const oauth = server();
    const { registration, verifier, code } = await authorize(oauth);
    const body = {
      grant_type: "authorization_code",
      code,
      client_id: registration.client_id,
      code_verifier: verifier,
    };
    await oauth.token(body);
    await expect(oauth.token(body)).rejects.toThrow(/already-used/);
  });

  it("rejects an unknown code", async () => {
    const oauth = server();
    await expect(
      oauth.token({ grant_type: "authorization_code", code: "nope", code_verifier: "v" }),
    ).rejects.toThrow(/Unknown or already-used authorization code/);
  });

  it("rejects a code issued to another client", async () => {
    const oauth = server();
    const { registration, verifier, code } = await authorize(oauth);
    const other = oauth.registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    await expect(
      oauth.token({
        grant_type: "authorization_code",
        code,
        client_id: other.client_id,
        code_verifier: verifier,
      }),
    ).rejects.toThrow(/different client/);
  });

  it("rotates the refresh token", async () => {
    const oauth = server();
    const { registration, verifier, code } = await authorize(oauth);
    const first = (await oauth.token({
      grant_type: "authorization_code",
      code,
      client_id: registration.client_id,
      code_verifier: verifier,
    })) as Record<string, string>;

    const second = (await oauth.token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token!,
      client_id: registration.client_id,
    })) as Record<string, string>;
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // The old refresh token is dead.
    await expect(
      oauth.token({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token!,
        client_id: registration.client_id,
      }),
    ).rejects.toThrow(/invalid or has been revoked/);
  });

  it("returns invalid_grant for a dead refresh token, not invalid_request", async () => {
    const oauth = server();
    try {
      await oauth.token({ grant_type: "refresh_token", refresh_token: "nope" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe("invalid_grant");
    }
  });

  it("rejects an unsupported grant type", async () => {
    await expect(server().token({ grant_type: "client_credentials" })).rejects.toThrow(
      /Unsupported grant_type/,
    );
  });
});

describe("access tokens", () => {
  it("verifies a token it issued and binds it to the resource", async () => {
    const oauth = server();
    const registration = oauth.registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    const verifier = randomBytes(32).toString("base64url");
    const redirect = await oauth.authorize({
      clientId: registration.client_id,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: base64UrlSha256(verifier),
      codeChallengeMethod: "S256",
      userId: "user-42",
    });
    const code = new URL(redirect).searchParams.get("code")!;
    const tokens = (await oauth.token({
      grant_type: "authorization_code",
      code,
      client_id: registration.client_id,
      code_verifier: verifier,
    })) as Record<string, string>;

    const claims = await oauth.verifyAccessToken(tokens.access_token!);
    expect(claims?.sub).toBe("user-42");
    expect(claims?.aud).toBe(RESOURCE);
    expect(claims?.iss).toBe(ISSUER);
  });

  it("rejects a token it did not issue", async () => {
    const oauth = server();
    expect(await oauth.verifyAccessToken("not.a.token")).toBeUndefined();
  });

  it("revokes a refresh token", async () => {
    const oauth = server();
    const registration = oauth.registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    const verifier = randomBytes(32).toString("base64url");
    const redirect = await oauth.authorize({
      clientId: registration.client_id,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: base64UrlSha256(verifier),
      codeChallengeMethod: "S256",
      userId: "u",
    });
    const code = new URL(redirect).searchParams.get("code")!;
    const tokens = (await oauth.token({
      grant_type: "authorization_code",
      code,
      client_id: registration.client_id,
      code_verifier: verifier,
    })) as Record<string, string>;

    oauth.revoke({ token: tokens.refresh_token! });
    await expect(
      oauth.token({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token!,
        client_id: registration.client_id,
      }),
    ).rejects.toThrow(/invalid or has been revoked/);
  });
});

describe("InMemoryUserStore", () => {
  it("stores and finds a user by email, case-insensitively", async () => {
    const store = new InMemoryUserStore();
    const created = await store.create("Alice@Example.com", "hash");
    expect(created.email).toBe("alice@example.com");
    expect(await store.findByEmail("ALICE@EXAMPLE.COM")).toBeDefined();
  });
});

describe("base64UrlSha256", () => {
  it("matches the RFC 7636 verifier transformation", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = createHash("sha256").update(verifier, "ascii").digest("base64url");
    expect(base64UrlSha256(verifier)).toBe(expected);
  });
});
