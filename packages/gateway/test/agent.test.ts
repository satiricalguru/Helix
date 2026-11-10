import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent.js";
import { McpClient } from "../src/mcp-client.js";
import type { IrEvent } from "@helix/local-adapter";
import type { MessagesRequest, Tool } from "@helix/contracts";

const request = (): MessagesRequest =>
  ({
    model: "helix-fable-5-2",
    max_tokens: 256,
    messages: [{ role: "user", content: "make a video of a lighthouse" }],
  }) as MessagesRequest;

const mcpTool: Tool = {
  name: "generate_video",
  description: "Generate a video.",
  input_schema: { type: "object", properties: { prompt: { type: "string" } } },
};

/** A stream of IR events for one upstream turn. */
function turn(events: IrEvent[]): (req: unknown) => AsyncGenerator<IrEvent> {
  return async function* () {
    for (const e of events) yield e;
  };
}

describe("runAgent — a model that does not call a tool", () => {
  it("passes the text through and stops", async () => {
    const events: IrEvent[] = [];
    for await (const e of runAgent({
      request: request(),
      model: "local:test-model",
      stream: turn([
        { kind: "text", text: "here you go" },
        { kind: "finish", stopReason: "end_turn", stopSequence: null },
      ]),
      features: { reasoningEffort: false, jsonSchema: false, parallelToolCalls: true },
    })) {
      events.push(e);
    }
    expect(events).toContainEqual({ kind: "text", text: "here you go" });
    expect(events.some((e) => e.kind === "finish")).toBe(true);
  });

  it("sends the upstream model name, not the advertised one", async () => {
    // Regression: the upstream model server knows the model by its own name,
    // so the advertised id must never reach it.
    let sentModel: string | undefined;
    const stream = (req: { model?: string }): AsyncGenerator<IrEvent> => {
      sentModel = req.model;
      return turn([{ kind: "finish", stopReason: "end_turn", stopSequence: null }])();
    };
    for await (const _ of runAgent({
      request: request(),
      model: "llama3.2:3b",
      stream: stream as never,
      features: { reasoningEffort: false, jsonSchema: false, parallelToolCalls: true },
    })) {
      void _;
    }
    expect(sentModel).toBe("llama3.2:3b");
    expect(sentModel).not.toBe("helix-fable-5-2");
  });
});

describe("runAgent — executing an MCP tool", () => {
  it("calls the tool and feeds the result back for another turn", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "https://cdn.example/lighthouse.mp4" }],
    }));

    let turnIndex = 0;
    const stream = (): AsyncGenerator<IrEvent> => {
      turnIndex++;
      if (turnIndex === 1) {
        return turn([
          { kind: "tool_start", index: 0, id: "call_1", name: "generate_video" },
          { kind: "tool_args", index: 0, partialJson: '{"prompt":"a lighthouse"}' },
          { kind: "tool_end", index: 0 },
        ])();
      }
      return turn([
        { kind: "text", text: "The video is ready." },
        { kind: "finish", stopReason: "end_turn", stopSequence: null },
      ])();
    };

    const events: IrEvent[] = [];
    for await (const e of runAgent({
      request: request(),
      model: "local:test-model",
      stream: stream as never,
      mcp: { callTool } as never,
      mcpTools: [mcpTool],
      features: { reasoningEffort: false, jsonSchema: false, parallelToolCalls: true },
    })) {
      events.push(e);
    }

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("generate_video", { prompt: "a lighthouse" });
    expect(events).toContainEqual({ kind: "text", text: "The video is ready." });
    // The internally executed tool call is not surfaced as a tool_use.
    expect(events.some((e) => e.kind === "tool_start")).toBe(false);
  });

  it("surfaces a tool failure to the model instead of throwing", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("generation unavailable");
    });

    let turnIndex = 0;
    const stream = (): AsyncGenerator<IrEvent> => {
      turnIndex++;
      if (turnIndex === 1) {
        return turn([
          { kind: "tool_start", index: 0, id: "call_1", name: "generate_video" },
          { kind: "tool_args", index: 0, partialJson: "{}" },
          { kind: "tool_end", index: 0 },
        ])();
      }
      return turn([
        { kind: "text", text: "I could not generate that." },
        { kind: "finish", stopReason: "end_turn", stopSequence: null },
      ])();
    };

    const events: IrEvent[] = [];
    for await (const e of runAgent({
      request: request(),
      model: "local:test-model",
      stream: stream as never,
      mcp: { callTool } as never,
      mcpTools: [mcpTool],
      features: { reasoningEffort: false, jsonSchema: false, parallelToolCalls: true },
    })) {
      events.push(e);
    }
    expect(events).toContainEqual({ kind: "text", text: "I could not generate that." });
  });

  it("gives up after the turn limit", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const stream = (): AsyncGenerator<IrEvent> =>
      turn([
        { kind: "tool_start", index: 0, id: "call_x", name: "generate_video" },
        { kind: "tool_args", index: 0, partialJson: "{}" },
        { kind: "tool_end", index: 0 },
      ])();

    const events: IrEvent[] = [];
    for await (const e of runAgent({
      request: request(),
      model: "local:test-model",
      stream: stream as never,
      mcp: { callTool } as never,
      mcpTools: [mcpTool],
      maxTurns: 2,
      features: { reasoningEffort: false, jsonSchema: false, parallelToolCalls: true },
    })) {
      events.push(e);
    }
    expect(callTool.mock.calls.length).toBeLessThanOrEqual(3);
    expect(events.some((e) => e.kind === "finish")).toBe(true);
  });
});

describe("runAgent — a tool the client declared", () => {
  it("returns the call to the client with stop_reason tool_use", async () => {
    const callTool = vi.fn();
    const events: IrEvent[] = [];
    for await (const e of runAgent({
      request: {
        ...request(),
        tools: [{ name: "client_tool", input_schema: { type: "object" } }],
      },
      model: "local:test-model",
      stream: turn([
        { kind: "tool_start", index: 0, id: "call_1", name: "client_tool" },
        { kind: "tool_args", index: 0, partialJson: '{"a":1}' },
        { kind: "tool_end", index: 0 },
      ]) as never,
      mcp: { callTool } as never,
      mcpTools: [mcpTool],
      features: { reasoningEffort: false, jsonSchema: false, parallelToolCalls: true },
    })) {
      events.push(e);
    }

    expect(callTool).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: "tool_start", index: 0, id: "call_1", name: "client_tool" });
    expect(events).toContainEqual({ kind: "finish", stopReason: "tool_use", stopSequence: null });
  });
});

describe("McpClient", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("lists tools", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { resultType: "complete", tools: [{ name: "generate_video", inputSchema: { type: "object" } }] },
      })) as unknown as typeof fetch;
    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["generate_video"]);
  });

  it("sends the bearer token and the protocol headers", async () => {
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } });
    }) as unknown as typeof fetch;

    const client = new McpClient({ url: "https://mcp.example/mcp", token: "tok", fetchImpl });
    await client.listTools();
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(headers["mcp-method"]).toBe("tools/list");
    expect(body.method).toBe("tools/list");
  });

  it("reads an SSE-framed result", async () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "complete", tools: [{ name: "t", inputSchema: { type: "object" } }] },
    });
    const fetchImpl = (async () =>
      new Response(`event: message\ndata: ${payload}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    expect((await client.listTools()).map((t) => t.name)).toEqual(["t"]);
  });

  it("raises on a non-2xx response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    await expect(client.listTools()).rejects.toThrow(/401/);
  });

  it("raises on a JSON-RPC error", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } })) as unknown as typeof fetch;
    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    await expect(client.listTools()).rejects.toThrow(/MCP error -32602/);
  });

  it("calls a tool", async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: { name: string } };
      expect(body.params.name).toBe("generate_video");
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { resultType: "complete", content: [{ type: "text", text: "done" }] },
      });
    }) as unknown as typeof fetch;
    const client = new McpClient({ url: "https://mcp.example/mcp", fetchImpl });
    const result = await client.callTool("generate_video", { prompt: "x" });
    expect(result.content[0]).toEqual({ type: "text", text: "done" });
  });
});
