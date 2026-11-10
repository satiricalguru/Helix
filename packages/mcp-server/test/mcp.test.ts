import { describe, expect, it } from "vitest";
import { McpServer, McpProtocolError } from "../src/server.js";
import { TaskStore } from "../src/tasks.js";
import { buildTools, toMcpTool, type ToolDefinition } from "../src/tools.js";
import { DEFAULT_HF_CATALOG } from "@helix/config";
import { InMemoryQuotaStore, QuotaService } from "@helix/quota";
import type { HfClient } from "@helix/hf-client";
import {
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  TASKS_EXTENSION,
  type JsonRpcRequest,
} from "@helix/contracts";

/* ------------------------------------------------------------ setup */

const modernMeta = (extra: Record<string, unknown> = {}) => ({
  [META_PROTOCOL_VERSION]: "2026-07-28",
  [META_CLIENT_INFO]: { name: "test-client", version: "1.0.0" },
  [META_CLIENT_CAPABILITIES]: {},
  ...extra,
});

function makeServer(overrides: Partial<ConstructorParameters<typeof McpServer>[0]> = {}) {
  const tools = buildTools({
    hf: undefined,
    catalog: DEFAULT_HF_CATALOG,
    quota: new QuotaService(new InMemoryQuotaStore()),
    dailyUsdBudget: 10,
  });
  return new McpServer({
    name: "helix",
    version: "0.1.0",
    instructions: "Helix generates images and video.",
    tools,
    tasks: new TaskStore(),
    enableTasks: true,
    ...overrides,
  });
}

function req(method: string, params: Record<string, unknown> = {}, id: number = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

const ctx = {
  subject: "tenant-1",
  signal: new AbortController().signal,
  progress: () => {},
};

/* ------------------------------------------------------------ tests */

describe("MCP — modern era", () => {
  it("answers server/discover with the supported versions and capabilities", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("server/discover", { _meta: modernMeta() }),
      ctx,
    );
    expect(res).toHaveProperty("result");
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toContain("2026-07-28");
    expect(result.instructions).toContain("Helix");
    expect(result.ttlMs).toBeGreaterThan(0);
    expect(result.cacheScope).toBe("public");
  });

  it("lists the tools with caching hints", async () => {
    const server = makeServer();
    const res = await server.handle(req("tools/list", { _meta: modernMeta() }), ctx);
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.resultType).toBe("complete");
    expect(result.ttlMs).toBeGreaterThan(0);
    expect(result.cacheScope).toBe("public");
    const tools = result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    expect(tools.map((t) => t.name)).toContain("generate_video");
    expect(tools.map((t) => t.name)).toContain("generate_image");
  });

  it("returns tools in a deterministic order", async () => {
    const server = makeServer();
    const first = await server.handle(req("tools/list", { _meta: modernMeta() }), ctx);
    const second = await server.handle(req("tools/list", { _meta: modernMeta() }), ctx);
    const a = (first as { result: { tools: unknown[] } }).result.tools;
    const b = (second as { result: { tools: unknown[] } }).result.tools;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("rejects a modern client that omits _meta", async () => {
    const server = makeServer();
    const res = await server.handle(req("tools/list"), {
      ...ctx,
      protocolVersionHeader: "2026-07-28",
    });
    expect(res).toHaveProperty("error");
    expect((res as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("rejects a modern request with no client capabilities", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("tools/list", {
        _meta: { [META_PROTOCOL_VERSION]: "2026-07-28" },
      }),
      ctx,
    );
    expect(res).toHaveProperty("error");
    expect((res as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("reports an unknown method as a protocol error", async () => {
    const server = makeServer();
    const res = await server.handle(req("does/not/exist", { _meta: modernMeta() }), ctx);
    expect(res).toHaveProperty("error");
    expect((res as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("reports an unknown tool as invalid params", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("tools/call", { name: "nope", arguments: {}, _meta: modernMeta() }),
      ctx,
    );
    expect((res as { error: { code: number } }).error.code).toBe(-32602);
  });
});

describe("MCP — legacy era", () => {
  it("answers initialize with the protocol version and server info", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy", version: "1" },
      }),
      ctx,
    );
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.serverInfo).toMatchObject({ name: "helix" });
    expect(result.instructions).toBeTruthy();
    // Legacy results carry no resultType.
    expect(result.resultType).toBeUndefined();
  });

  it("negotiates down to a client version it supports", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } }),
      ctx,
    );
    expect((res as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-03-26");
  });

  it("falls back to the current version for an unknown requested version", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "c", version: "1" } }),
      ctx,
    );
    expect((res as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2026-07-28");
  });

  it("serves tools/list without a resultType to a legacy client", async () => {
    const server = makeServer();
    const res = await server.handle(req("tools/list", {}), {
      ...ctx,
      protocolVersionHeader: "2025-11-25",
    });
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.resultType).toBeUndefined();
    expect(result.tools).toBeDefined();
  });
});

describe("MCP — tool execution", () => {
  it("runs a read-only tool and returns structured content", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("tools/call", { name: "list_generation_models", arguments: {}, _meta: modernMeta() }),
      ctx,
    );
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.content).toBeDefined();
    expect(result.structuredContent).toMatchObject({ models: expect.any(Array) });
  });

  it("reports an error for an unknown model without throwing", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("tools/call", {
        name: "get_generation_model",
        arguments: { endpoint_id: "does/not/exist" },
        _meta: modernMeta(),
      }),
      ctx,
    );
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.isError).toBe(true);
  });

  it("reports a missing Higgsfield credential as a tool error, not a crash", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("tools/call", {
        name: "generate_image",
        arguments: { prompt: "a cat" },
        _meta: modernMeta(),
      }),
      ctx,
    );
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.isError).toBe(true);
  });

  it("returns a task for a long-running tool when the client supports tasks", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("tools/call", {
        name: "generate_video",
        arguments: { prompt: "a cat" },
        _meta: modernMeta({
          [META_CLIENT_CAPABILITIES]: { extensions: { [TASKS_EXTENSION]: {} } },
        }),
      }),
      ctx,
    );
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.taskId).toBeTruthy();
    expect(result.status).toBe("working");
    expect(result.pollIntervalMs).toBeGreaterThan(0);
  });

  it("does not return a task when the client does not declare the extension", async () => {
    const server = makeServer();
    const res = await server.handle(
      req("tools/call", {
        name: "generate_video",
        arguments: { prompt: "a cat" },
        _meta: modernMeta(),
      }),
      ctx,
    );
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.taskId).toBeUndefined();
    expect(result.isError).toBe(true);
  });
});

describe("MCP — tasks extension", () => {
  it("resolves a task", async () => {
    const server = makeServer();
    const created = server.tasks.create({
      taskId: "task-1",
      toolName: "generate_video",
      arguments: {},
    });
    expect(created.task.status).toBe("working");

    const res = await server.handle(req("tasks/get", { taskId: "task-1", _meta: modernMeta() }), ctx);
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.task).toMatchObject({ taskId: "task-1", status: "working" });
  });

  it("completes a task", async () => {
    const server = makeServer();
    server.tasks.create({ taskId: "task-2", toolName: "t", arguments: {} });
    server.tasks.update("task-2", "completed", { result: { urls: ["https://cdn/x.mp4"] } });
    const res = await server.handle(req("tasks/get", { taskId: "task-2", _meta: modernMeta() }), ctx);
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.task).toMatchObject({ status: "completed" });
    expect(result.result).toMatchObject({ urls: ["https://cdn/x.mp4"] });
  });

  it("cancels a task", async () => {
    const server = makeServer();
    server.tasks.create({ taskId: "task-3", toolName: "t", arguments: {} });
    const res = await server.handle(req("tasks/cancel", { taskId: "task-3", _meta: modernMeta() }), ctx);
    expect((res as { result: { task: { status: string } } }).result.task.status).toBe("cancelled");
  });

  it("reports an unknown task as invalid params", async () => {
    const server = makeServer();
    const res = await server.handle(req("tasks/get", { taskId: "nope", _meta: modernMeta() }), ctx);
    expect((res as { error: { code: number } }).error.code).toBe(-32602);
  });
});

describe("MCP — resources and prompts", () => {
  const server = makeServer({
    resources: [
      {
        uri: "helix://models",
        name: "Generation models",
        mimeType: "application/json",
        read: async () => [{ uri: "helix://models", mimeType: "application/json", text: "[]" }],
      },
    ],
    prompts: [
      {
        name: "aura-edit",
        description: "Recreate an aura edit from a reference video.",
        arguments: [{ name: "reference", required: true }],
        get: async (args) => ({
          messages: [
            { role: "user", content: { type: "text", text: `Aura edit for ${args.reference ?? "?"}` } },
          ],
        }),
      },
    ],
  });

  it("lists resources", async () => {
    const res = await server.handle(req("resources/list", { _meta: modernMeta() }), ctx);
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.resources).toEqual([
      expect.objectContaining({ uri: "helix://models", name: "Generation models" }),
    ]);
    expect(result.cacheScope).toBe("public");
  });

  it("reads a resource", async () => {
    const res = await server.handle(
      req("resources/read", { uri: "helix://models", _meta: modernMeta() }),
      ctx,
    );
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.contents).toEqual([
      { uri: "helix://models", mimeType: "application/json", text: "[]" },
    ]);
    expect(result.cacheScope).toBe("private");
  });

  it("reports a missing resource as invalid params", async () => {
    const res = await server.handle(
      req("resources/read", { uri: "helix://nope", _meta: modernMeta() }),
      ctx,
    );
    expect((res as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("lists prompts", async () => {
    const res = await server.handle(req("prompts/list", { _meta: modernMeta() }), ctx);
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.prompts).toEqual([
      expect.objectContaining({ name: "aura-edit" }),
    ]);
  });

  it("gets a prompt with its arguments", async () => {
    const res = await server.handle(
      req("prompts/get", { name: "aura-edit", arguments: { reference: "clip.mp4" }, _meta: modernMeta() }),
      ctx,
    );
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.messages).toEqual([
      { role: "user", content: { type: "text", text: "Aura edit for clip.mp4" } },
    ]);
  });
});

describe("tool definitions", () => {
  it("states that outputs are AI-generated and cost money", () => {
    const tools = buildTools({
      hf: undefined,
      catalog: DEFAULT_HF_CATALOG,
      quota: new QuotaService(new InMemoryQuotaStore()),
      dailyUsdBudget: 10,
    });
    const video = tools.find((t) => t.name === "generate_video")!;
    expect(video.description).toMatch(/AI-generated/);
    expect(video.description).toMatch(/consumes credits/);
    expect(video.estimate?.({ duration: 10 })).toBeGreaterThan(0);
  });

  it("marks mutating tools as not read-only", () => {
    const tools = buildTools({
      hf: undefined,
      catalog: DEFAULT_HF_CATALOG,
      quota: new QuotaService(new InMemoryQuotaStore()),
      dailyUsdBudget: 10,
    });
    const video = tools.find((t) => t.name === "generate_video")!;
    expect(video.annotations.readOnlyHint).toBe(false);
    expect(video.annotations.idempotentHint).toBe(true);
  });

  it("converts to the MCP wire shape", () => {
    const tool: ToolDefinition = {
      name: "x",
      title: "X",
      description: "d",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      readOnly: true,
      run: async () => ({ content: [] }),
    };
    expect(toMcpTool(tool)).toMatchObject({
      name: "x",
      title: "X",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
  });
});

describe("McpProtocolError", () => {
  it("carries a JSON-RPC error code", () => {
    const err = new McpProtocolError(-32602, "bad");
    expect(err.code).toBe(-32602);
  });
});
