/**
 * MCP server core: the JSON-RPC dispatcher.
 *
 * Serves both protocol eras:
 *   - modern 2026-07-28: stateless, per-request `_meta`, `resultType` on every
 *     result, `ttlMs`/`cacheScope` on list and read results.
 *   - legacy 2025-11-25 and earlier: `initialize` handshake, no `resultType`.
 *
 * A modern client is identified by the presence of the per-request protocol
 * version in `params._meta`; a legacy client by sending `initialize`.
 */

import {
  JsonRpcErrorCode,
  MCP_PROTOCOL_VERSION_LEGACY,
  MCP_PROTOCOL_VERSION_MODERN,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  TASKS_EXTENSION,
  type JsonRpcFailure,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type McpResource,
  type McpResourceTemplate,
  type McpPrompt,
} from "@helix/contracts";
import { toMcpTool, type ToolDefinition } from "./tools.js";
import { TaskStore } from "./tasks.js";

export interface ResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  read: (uri: string) => Promise<Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>>;
}

export interface PromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  get: (args: Record<string, string>) => Promise<{
    description?: string;
    messages: Array<{ role: "user" | "assistant"; content: { type: "text"; text: string } }>;
  }>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  instructions: string;
  tools: ToolDefinition[];
  resources?: ResourceDefinition[];
  resourceTemplates?: McpResourceTemplate[];
  prompts?: PromptDefinition[];
  tasks: TaskStore;
  /** Serve the tasks extension. */
  enableTasks?: boolean;
  /** Called when a tool run needs to report progress. */
  onProgress?: (taskId: string, progress: number, total: number | undefined, message: string) => void;
  /** Called when a tool is invoked, for audit logging. */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
}

export interface DispatchContext {
  /** The subject the call is billed to. */
  subject: string;
  /** Aborts when the client disconnects. */
  signal: AbortSignal;
  /** Progress sink for the current request. */
  progress: (progress: number, total: number | undefined, message: string) => void;
  /** The client's declared capabilities, if any. */
  clientCapabilities?: Record<string, unknown>;
  /** The client-declared protocol version, if any. */
  protocolVersion?: string;
  /**
   * The `MCP-Protocol-Version` request header.
   *
   * This is how a stateless server tells the two eras apart: a modern client
   * sends `2026-07-28` (and also puts the version in `_meta`), a legacy client
   * sends `2025-11-25` or nothing.
   */
  protocolVersionHeader?: string;
  /** The upstream token to use for a relayed call, when it differs. */
  upstreamToken?: string;
  /**
   * The identity of the connected client, forwarded to an upstream server.
   *
   * Absent when the caller is Helix's own gateway rather than a real client.
   */
  clientInfo?: { name: string; title?: string; version?: string };
}

const MODERN = "modern";
const LEGACY = "legacy";

export class McpServer {
  #opts: McpServerOptions;

  constructor(opts: McpServerOptions) {
    this.#opts = opts;
  }

  get tools(): ToolDefinition[] {
    return this.#opts.tools;
  }

  get tasks(): TaskStore {
    return this.#opts.tasks;
  }

  /** True when the client declared the tasks extension. */
  #clientSupportsTasks(capabilities: Record<string, unknown> | undefined): boolean {
    const extensions = capabilities?.extensions as Record<string, unknown> | undefined;
    return Boolean(extensions && TASKS_EXTENSION in extensions);
  }

  /** Handle a request and produce a JSON-RPC response. */
  async handle(
    request: JsonRpcRequest,
    ctx: DispatchContext,
  ): Promise<JsonRpcSuccess | JsonRpcFailure> {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const headerVersion = ctx.protocolVersionHeader;
    // A client is "modern" if it sends the per-request `_meta` version or
    // declares 2026-07-28 in the protocol-version header.
    const declaresModern =
      typeof meta[META_PROTOCOL_VERSION] === "string" ||
      (typeof headerVersion === "string" && headerVersion >= MCP_PROTOCOL_VERSION_MODERN);
    const era = declaresModern ? MODERN : LEGACY;

    if (era === MODERN) {
      // A modern request must carry the version and the client capabilities.
      if (typeof meta[META_PROTOCOL_VERSION] !== "string") {
        return failure(request.id, JsonRpcErrorCode.InvalidParams, "Missing io.modelcontextprotocol/protocolVersion in _meta.");
      }
      if (meta[META_CLIENT_CAPABILITIES] === undefined) {
        return failure(
          request.id,
          JsonRpcErrorCode.InvalidParams,
          "Missing io.modelcontextprotocol/clientCapabilities in _meta.",
        );
      }
    }

    const capabilities = meta[META_CLIENT_CAPABILITIES] as Record<string, unknown> | undefined;
    const protocolVersion =
      (meta[META_PROTOCOL_VERSION] as string | undefined) ??
      headerVersion ??
      MCP_PROTOCOL_VERSION_LEGACY;

    // The identity of the client that is actually connected. It is forwarded to
    // an upstream generation server so the upstream sees the real client.
    const clientInfo = (meta[META_CLIENT_INFO] as
      | { name?: string; title?: string; version?: string }
      | undefined) ?? undefined;

    const enriched: DispatchContext = {
      ...ctx,
      clientCapabilities: capabilities,
      protocolVersion,
      ...(clientInfo?.name
        ? {
            clientInfo: {
              name: clientInfo.name,
              ...(clientInfo.title ? { title: clientInfo.title } : {}),
              ...(clientInfo.version ? { version: clientInfo.version } : {}),
            },
          }
        : {}),
    };

    try {
      const result = await this.#dispatch(request.method, params, enriched, era);
      if (result === null) {
        // A notification that we answer with an empty result.
        return { jsonrpc: "2.0", id: request.id, result: era === MODERN ? { resultType: "complete" } : {} };
      }
      const body = era === MODERN ? { resultType: "complete", ...result } : result;
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          ...body,
          ...(era === MODERN
            ? { _meta: { [META_SERVER_INFO]: { name: this.#opts.name, version: this.#opts.version } } }
            : {}),
        },
      };
    } catch (err) {
      if (err instanceof McpProtocolError) {
        return failure(request.id, err.code, err.message, err.data);
      }
      return failure(request.id, JsonRpcErrorCode.InternalError, err instanceof Error ? err.message : String(err));
    }
  }

  async #dispatch(
    method: string,
    params: Record<string, unknown>,
    ctx: DispatchContext,
    era: string,
  ): Promise<Record<string, unknown> | null> {
    switch (method) {
      /* ---------------------------------------------------- discovery */
      case "server/discover":
        return {
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: this.#capabilities(),
          instructions: this.#opts.instructions,
          ttlMs: 3_600_000,
          cacheScope: "public",
        };

      case "initialize":
        return {
          protocolVersion: this.#negotiateVersion(params.protocolVersion),
          capabilities: this.#capabilities(),
          serverInfo: { name: this.#opts.name, title: this.#opts.name, version: this.#opts.version },
          instructions: this.#opts.instructions,
        };

      /* ---------------------------------------------------------- tools */
      case "tools/list": {
        const tools = this.#opts.tools.map(toMcpTool);
        return {
          tools,
          ttlMs: 300_000,
          cacheScope: "public",
        };
      }

      case "tools/call": {
        const name = String(params.name ?? "");
        const tool = this.#opts.tools.find((t) => t.name === name);
        if (!tool) {
          throw new McpProtocolError(
            JsonRpcErrorCode.InvalidParams,
            `Unknown tool: ${name}`,
          );
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const idempotencyKey = `${ctx.subject}:${name}:${stableHash(args)}`;
        this.#opts.onToolCall?.(name, args);
        const result = await tool.run(args, {
          subject: ctx.subject,
          progress: ctx.progress,
          signal: ctx.signal,
          idempotencyKey,
          ...(ctx.clientInfo ? { clientInfo: ctx.clientInfo } : {}),
          ...(ctx.upstreamToken ? { upstreamToken: ctx.upstreamToken } : {}),
        });
        if (era === MODERN && tool.longRunning && this.#clientSupportsTasks(ctx.clientCapabilities)) {
          // Long-running work becomes a task the client polls.
          const taskId = `task-${idempotencyKey.slice(0, 24)}`;
          this.#opts.tasks.create({
            taskId,
            toolName: name,
            arguments: args,
            statusMessage: "Generation in progress.",
          });
          return {
            taskId,
            status: "working",
            statusMessage: "Generation in progress.",
            createdAt: new Date().toISOString(),
            lastUpdatedAt: new Date().toISOString(),
            ttlMs: 3_600_000,
            pollIntervalMs: 5000,
          };
        }
        return {
          content: result.content,
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
          ...(result.isError ? { isError: true } : {}),
        };
      }

      /* ------------------------------------------------------ resources */
      case "resources/list": {
        const resources: McpResource[] = (this.#opts.resources ?? []).map((r) => ({
          uri: r.uri,
          name: r.name,
          ...(r.title ? { title: r.title } : {}),
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        }));
        return { resources, ttlMs: 300_000, cacheScope: "public" };
      }

      case "resources/templates/list":
        return {
          resourceTemplates: this.#opts.resourceTemplates ?? [],
          ttlMs: 300_000,
          cacheScope: "public",
        };

      case "resources/read": {
        const uri = String(params.uri ?? "");
        const resource = (this.#opts.resources ?? []).find((r) => r.uri === uri);
        if (!resource) {
          throw new McpProtocolError(
            JsonRpcErrorCode.InvalidParams,
            `Resource not found: ${uri}`,
          );
        }
        const contents = await resource.read(uri);
        return { contents, ttlMs: 60_000, cacheScope: "private" };
      }

      /* -------------------------------------------------------- prompts */
      case "prompts/list": {
        const prompts: McpPrompt[] = (this.#opts.prompts ?? []).map((p) => ({
          name: p.name,
          ...(p.title ? { title: p.title } : {}),
          ...(p.description ? { description: p.description } : {}),
          ...(p.arguments ? { arguments: p.arguments } : {}),
        }));
        return { prompts, ttlMs: 300_000, cacheScope: "public" };
      }

      case "prompts/get": {
        const name = String(params.name ?? "");
        const prompt = (this.#opts.prompts ?? []).find((p) => p.name === name);
        if (!prompt) {
          throw new McpProtocolError(JsonRpcErrorCode.InvalidParams, `Unknown prompt: ${name}`);
        }
        const args = (params.arguments ?? {}) as Record<string, string>;
        return await prompt.get(args);
      }

      /* ---------------------------------------------------------- tasks */
      case "tasks/get": {
        const taskId = String(params.taskId ?? "");
        const record = this.#opts.tasks.get(taskId);
        if (!record) {
          throw new McpProtocolError(JsonRpcErrorCode.InvalidParams, `Unknown task: ${taskId}`);
        }
        return {
          task: record.task,
          ...(record.result ? { result: record.result } : {}),
          ...(record.error ? { error: record.error } : {}),
        };
      }

      case "tasks/update": {
        const taskId = String(params.taskId ?? "");
        const record = this.#opts.tasks.update(taskId, "working", {
          statusMessage: "Updated by the client.",
        });
        if (!record) {
          throw new McpProtocolError(JsonRpcErrorCode.InvalidParams, `Unknown task: ${taskId}`);
        }
        return { task: record.task };
      }

      case "tasks/cancel": {
        const taskId = String(params.taskId ?? "");
        const record = this.#opts.tasks.cancel(taskId);
        if (!record) {
          throw new McpProtocolError(JsonRpcErrorCode.InvalidParams, `Unknown task: ${taskId}`);
        }
        return { task: record.task };
      }

      case "ping":
        return {};

      default:
        throw new McpProtocolError(
          JsonRpcErrorCode.MethodNotFound,
          `Method not found: ${method}`,
        );
    }
  }

  #capabilities(): Record<string, unknown> {
    return {
      tools: { listChanged: true },
      resources: { subscribe: false, listChanged: true },
      prompts: { listChanged: true },
      completions: {},
      ...(this.#opts.enableTasks
        ? { extensions: { [TASKS_EXTENSION]: {} } }
        : {}),
    };
  }

  #negotiateVersion(requested: unknown): string {
    if (typeof requested !== "string") return MCP_PROTOCOL_VERSION_MODERN;
    if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) return requested;
    return MCP_PROTOCOL_VERSION_MODERN;
  }
}

export class McpProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.data = data;
  }
}

function failure(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/** Stable, order-insensitive hash used for idempotency keys. */
function stableHash(value: unknown): string {
  const json = stableStringify(value);
  let h = 2166136261;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export type { JsonRpcNotification };
