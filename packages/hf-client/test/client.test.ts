import { describe, expect, it, vi } from "vitest";
import { HfApiError, HfClient, isTerminal, outputUrls, toHfError } from "../src/client.js";

const creds = { keyId: "key_123", keySecret: "secret_456" };

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("HfClient — submit", () => {
  it("posts to the endpoint with the Key authorization header", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetchImpl = (async (u: string | URL | Request, i?: RequestInit) => {
      url = String(u);
      init = i;
      return jsonResponse({
        status: "queued",
        request_id: "req-1",
        status_url: "https://api.higgsfield.ai/requests/req-1/status",
        cancel_url: "https://api.higgsfield.ai/requests/req-1/cancel",
        expires_after: 604800,
      });
    }) as unknown as typeof fetch;

    const client = new HfClient({ credentials: creds, fetchImpl });
    const res = await client.submit("higgsfield/cinema-studio/4.0", { prompt: "a cat" });

    expect(url).toBe("https://api.higgsfield.ai/higgsfield/cinema-studio/4.0");
    expect((init?.headers as Record<string, string>).authorization).toBe("Key key_123:secret_456");
    expect(JSON.parse(String(init?.body))).toEqual({ prompt: "a cat" });
    expect(res.request_id).toBe("req-1");
  });

  it("sends an Idempotency-Key when supplied", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_u: string | URL | Request, i?: RequestInit) => {
      headers = (i?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ status: "queued", request_id: "r" });
    }) as unknown as typeof fetch;

    const client = new HfClient({ credentials: creds, fetchImpl });
    await client.submit("higgsfield/x", {}, { idempotencyKey: "idem-123" });
    expect(headers["idempotency-key"]).toBe("idem-123");
  });

  it("adds the webhook url as a query parameter", async () => {
    let url = "";
    const fetchImpl = (async (u: string | URL | Request) => {
      url = String(u);
      return jsonResponse({ status: "queued", request_id: "r" });
    }) as unknown as typeof fetch;

    const client = new HfClient({ credentials: creds, fetchImpl });
    await client.submit("higgsfield/x", {}, { webhookUrl: "https://helix.example/hooks/hf" });
    expect(url).toContain("hf_webhook=");
    expect(decodeURIComponent(url)).toContain("https://helix.example/hooks/hf");
  });

  it("sends Hf-Expires-After when supplied", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_u: string | URL | Request, i?: RequestInit) => {
      headers = (i?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ status: "queued", request_id: "r" });
    }) as unknown as typeof fetch;

    const client = new HfClient({ credentials: creds, fetchImpl });
    await client.submit("higgsfield/x", {}, { expiresAfter: 3600 });
    expect(headers["hf-expires-after"]).toBe("3600");
  });
});

describe("HfClient — status, cancel, delete", () => {
  it("polls the status endpoint", async () => {
    let url = "";
    const fetchImpl = (async (u: string | URL | Request) => {
      url = String(u);
      return jsonResponse({ status: "completed", request_id: "r", video: { url: "https://cdn/v.mp4" } });
    }) as unknown as typeof fetch;

    const client = new HfClient({ credentials: creds, fetchImpl });
    const status = await client.getStatus("req-9");
    expect(url).toBe("https://api.higgsfield.ai/requests/req-9/status");
    expect(status.video?.url).toBe("https://cdn/v.mp4");
  });

  it("cancels a queued request", async () => {
    let url = "";
    let method = "";
    const fetchImpl = (async (u: string | URL | Request, i?: RequestInit) => {
      url = String(u);
      method = i?.method ?? "";
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;

    const client = new HfClient({ credentials: creds, fetchImpl });
    await client.cancel("req-9");
    expect(url).toBe("https://api.higgsfield.ai/requests/req-9/cancel");
    expect(method).toBe("POST");
  });

  it("deletes a finished request", async () => {
    let url = "";
    let method = "";
    const fetchImpl = (async (u: string | URL | Request, i?: RequestInit) => {
      url = String(u);
      method = i?.method ?? "";
      return jsonResponse({ request_id: "r", status: "deleted" });
    }) as unknown as typeof fetch;

    const client = new HfClient({ credentials: creds, fetchImpl });
    await client.delete("req-9");
    expect(url).toBe("https://api.higgsfield.ai/requests/req-9");
    expect(method).toBe("DELETE");
  });

  it("url-encodes the request id", async () => {
    let url = "";
    const fetchImpl = (async (u: string | URL | Request) => {
      url = String(u);
      return jsonResponse({ status: "completed", request_id: "r" });
    }) as unknown as typeof fetch;
    const client = new HfClient({ credentials: creds, fetchImpl });
    await client.getStatus("a/b c");
    expect(url).toBe("https://api.higgsfield.ai/requests/a%2Fb%20c/status");
  });
});

describe("HfClient — errors", () => {
  it("raises a typed error for a 429 with a retry hint", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: {
            code: "account_queue_full",
            message: "Too many queued generations for this account",
            retryable: true,
            limit: 40,
            retry_after_seconds: 30,
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const client = new HfClient({ credentials: creds, fetchImpl });
    try {
      await client.submit("higgsfield/x", {});
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HfApiError);
      const e = err as HfApiError;
      expect(e.status).toBe(429);
      expect(e.code).toBe("account_queue_full");
      expect(e.retryable).toBe(true);
      expect(e.retryAfterSeconds).toBe(30);
    }
  });

  it("raises a typed error for a 401", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: "Invalid credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = new HfClient({ credentials: creds, fetchImpl });
    await expect(client.getStatus("r")).rejects.toBeInstanceOf(HfApiError);
  });
});

describe("toHfError", () => {
  it("parses the structured detail body", () => {
    const e = toHfError(429, JSON.stringify({ detail: { code: "account_queue_full", retryable: true } }), null);
    expect(e.code).toBe("account_queue_full");
    expect(e.retryable).toBe(true);
  });

  it("parses a plain string detail", () => {
    const e = toHfError(401, JSON.stringify({ detail: "Invalid credentials" }), null);
    expect(e.body).toContain("Invalid credentials");
  });

  it("falls back to the raw body when it is not JSON", () => {
    const e = toHfError(500, "boom", null);
    expect(e.message).toContain("500");
    expect(e.body).toBe("boom");
  });

  it("reads the retry-after header", () => {
    const e = toHfError(429, "{}", "45");
    expect(e.retryAfterSeconds).toBe(45);
  });

  it("marks 503 as retryable", () => {
    const e = toHfError(503, JSON.stringify({ code: "admission_control_unavailable" }), null);
    expect(e.retryable).toBe(true);
  });
});

describe("status helpers", () => {
  it("knows the terminal statuses", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("nsfw")).toBe(true);
    expect(isTerminal("canceled")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("in_progress")).toBe(false);
  });

  it("extracts every output url", () => {
    const urls = outputUrls({
      status: "completed",
      request_id: "r",
      images: [{ url: "https://cdn/a.png" }],
      video: { url: "https://cdn/v.mp4" },
      audio: { url: "https://cdn/a.mp3" },
      audios: [{ url: "https://cdn/b.mp3" }],
      zip: { url: "https://cdn/z.zip" },
    });
    expect(urls).toEqual([
      "https://cdn/a.png",
      "https://cdn/v.mp4",
      "https://cdn/a.mp3",
      "https://cdn/b.mp3",
      "https://cdn/z.zip",
    ]);
  });

  it("returns an empty list when there is nothing to extract", () => {
    expect(outputUrls({ status: "completed", request_id: "r" })).toEqual([]);
  });
});

describe("HfClient — configuration", () => {
  it("honours a custom base url", async () => {
    let url = "";
    const fetchImpl = (async (u: string | URL | Request) => {
      url = String(u);
      return jsonResponse({ status: "queued", request_id: "r" });
    }) as unknown as typeof fetch;
    const client = new HfClient({ credentials: creds, baseUrl: "http://localhost:9999/", fetchImpl });
    await client.submit("higgsfield/x", {});
    expect(url).toBe("http://localhost:9999/higgsfield/x");
  });

  it("does not leak the secret into the URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "queued", request_id: "r" })) as unknown as typeof fetch;
    const client = new HfClient({ credentials: creds, fetchImpl });
    await client.submit("higgsfield/x", {});
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(String(call[0])).not.toContain("secret_456");
  });
});
