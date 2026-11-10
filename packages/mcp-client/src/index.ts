/**
 * A minimal MCP client.
 *
 * Helix's gateway can act as the agent: the local model plans, calls the
 * generation tools on Helix's own MCP server, and Helix drives the tool loop.
 * This is the "Studio" mode, and it needs an MCP client that speaks the
 * modern Streamable HTTP protocol.
 */

import { META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_PROTOCOL_VERSION } from "@helix/contracts";

export interface McpClientOptions {
  url: string;
  /** Bearer token for the MCP server. */
  token?: string;
  /** Protocol version to negotiate. */
  protocolVersion?: string;
  timeoutMs?: number;
  /** How many times to retry a transient network failure. */
  retryAttempts?: number;
  fetchImpl?: typeof fetch;
}

/** The identity a client reports to an MCP server. */
export interface ClientIdentity {
  name: string;
  title?: string;
  version?: string;
}

export interface CallOptions {
  /** Override the bearer token for this call. */
  token?: string;
  /**
   * The identity to report.
   *
   * A relay forwards the identity of the client that is actually connected,
   * so the upstream sees the real client rather than the relay.
   */
  clientInfo?: ClientIdentity;
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export class McpClientError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "McpClientError";
    this.status = status;
  }
}

export class McpClient {
  #opts: McpClientOptions;
  #fetch: typeof fetch;
  #nextId = 1;

  constructor(opts: McpClientOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  get url(): string {
    return this.#opts.url;
  }

  #headers(method: string, name?: string, options: CallOptions = {}): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.#opts.protocolVersion ?? "2026-07-28",
      "mcp-method": method,
    };
    if (name) headers["mcp-name"] = name;
    const token = options.token ?? this.#opts.token;
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  /** The identity this client reports. */
  #clientInfo(options: CallOptions): ClientIdentity {
    const identity = options.clientInfo ?? { name: "helix", title: "Helix" };
    // `version` is required by the 2026-07-28 envelope, so fill it in.
    return { name: identity.name, ...(identity.title ? { title: identity.title } : {}), version: identity.version ?? "0.1.0" };
  }

  async #call(
    method: string,
    params: Record<string, unknown>,
    name?: string,
    options: CallOptions = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = this.#opts.timeoutMs
      ? setTimeout(() => controller.abort(), this.#opts.timeoutMs)
      : undefined;

    let response: Response;
    try {
      response = await this.#fetchWithRetry(this.#opts.url, {
        method: "POST",
        headers: this.#headers(method, name, options),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.#nextId++,
          method,
          params: {
            ...params,
            _meta: {
              [META_PROTOCOL_VERSION]: this.#opts.protocolVersion ?? "2026-07-28",
              [META_CLIENT_INFO]: this.#clientInfo(options),
              [META_CLIENT_CAPABILITIES]: {},
            },
          },
        }),
        signal: controller.signal,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new McpClientError(response.status, `MCP server returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const payload = await this.#readResult(response);
    if (payload && typeof payload === "object" && "error" in payload) {
      const err = payload as { error: { code: number; message: string } };
      throw new McpClientError(200, `MCP error ${err.error.code}: ${err.error.message}`);
    }
    const result = (payload as { result?: unknown } | null)?.result;
    return result;
  }

  /**
   * Fetch with a retry for transient network failures.
   *
   * A DNS blip or a dropped connection should not fail a generation that has
   * not been submitted yet. Only transport-level errors are retried; an HTTP
   * response of any status is returned as-is.
   */
  async #fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const attempts = this.#opts.retryAttempts ?? 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.#fetch(url, init);
      } catch (err) {
        lastError = err;
        if (!isTransientNetworkError(err) || attempt === attempts - 1) throw err;
        // Exponential backoff with a little jitter.
        const delay = Math.min(2000, 150 * 2 ** attempt) + Math.random() * 100;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  /** The MCP server may answer with JSON or with an SSE stream. */
  async #readResult(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      const dataLines = text
        .split("\n\n")
        .flatMap((frame) => frame.split("\n"))
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6));
      for (const line of dataLines) {
        if (line.trim() === "" || line.trim() === "[DONE]") continue;
        try {
          const parsed = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
          if (parsed.error) return parsed;
          if (parsed.result) return parsed;
        } catch {
          // Skip frames that are not JSON-RPC.
        }
      }
      return null;
    }
    return response.json();
  }

  /** Establish the session with the upstream server. */
  async initialize(options: CallOptions = {}): Promise<unknown> {
    return this.#call(
      "initialize",
      {
        protocolVersion: this.#opts.protocolVersion ?? "2026-07-28",
        capabilities: {},
        clientInfo: this.#clientInfo(options),
      },
      undefined,
      options,
    );
  }

  /** List the tools the server exposes. */
  async listTools(options: CallOptions = {}): Promise<McpToolDescriptor[]> {
    const result = (await this.#call("tools/list", {}, undefined, options)) as {
      tools?: McpToolDescriptor[];
    } | null;
    return result?.tools ?? [];
  }

  /** Call a tool and return its content blocks. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<{ content: Array<Record<string, unknown>>; isError?: boolean; structuredContent?: unknown }> {
    const result = (await this.#call(
      "tools/call",
      { name, arguments: args },
      name,
      options,
    )) as {
      content?: Array<Record<string, unknown>>;
      isError?: boolean;
      structuredContent?: unknown;
    } | null;
    return {
      content: result?.content ?? [],
      ...(result?.isError ? { isError: true } : {}),
      ...(result?.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
    };
  }

  /** Discover the server (modern protocol). */
  async discover(options: CallOptions = {}): Promise<Record<string, unknown> | null> {
    return (await this.#call("server/discover", {}, undefined, options)) as Record<
      string,
      unknown
    > | null;
  }
}

/**
 * True for transport-level failures worth retrying.
 *
 * DNS failures, connection resets and timeouts are transient; a 4xx/5xx
 * response is not, and neither is an abort.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  const cause = (err as { cause?: unknown })?.cause as
    | { code?: string; name?: string }
    | undefined;
  const code = cause?.code ?? "";
  const name = cause?.name ?? "";
  if (
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    name === "ConnectTimeoutError" ||
    name === "UND_ERR_CONNECT_TIMEOUT" ||
    name === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}
