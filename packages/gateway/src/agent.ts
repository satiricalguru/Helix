/**
 * The agent loop.
 *
 * In "Studio" mode the local model is the planner: it decides to call a
 * generation tool, Helix executes it against the MCP server, feeds the result
 * back, and the model finishes its answer. The whole exchange is emitted as
 * one continuous Anthropic stream.
 *
 * Tool calls the model makes against tools the *client* declared are not
 * intercepted: they are returned to the client in the normal Anthropic way.
 */

import type { MessagesRequest, MessageParam, Tool, ToolResultBlock } from "@helix/contracts";
import {
  toOpenAiRequest,
  type IrEvent,
  type LocalModelFeatures,
  type OpenAiChatRequest,
} from "@helix/local-adapter";
import type { McpClient } from "./mcp-client.js";

export interface AgentOptions {
  /** The Anthropic request as the client sent it. */
  request: MessagesRequest;
  /**
   * The upstream model name, e.g. "llama3.2:3b".
   *
   * This is not the advertised id: the request goes to the local model
   * server, which knows the model by its own name.
   */
  model: string;
  /** The upstream model client. */
  stream: (openAiRequest: OpenAiChatRequest) => AsyncGenerator<IrEvent>;
  /** The MCP client used to execute generation tools. */
  mcp?: McpClient;
  /** The tools the MCP server exposes. */
  mcpTools?: Tool[];
  /** Feature detection for the upstream model. */
  features: LocalModelFeatures;
  /** Maximum tool round trips before the loop gives up. */
  maxTurns?: number;
  /** Called when an MCP tool is executed. */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
}

/** A tool call the model made, recovered from the stream. */
interface CollectedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export async function* runAgent(options: AgentOptions): AsyncGenerator<IrEvent> {
  const maxTurns = options.maxTurns ?? 6;
  const mcpToolNames = new Set((options.mcpTools ?? []).map((t) => t.name));

  // The message history evolves as tool results come back.
  let messages = options.request.messages.map((m) => ({ ...m }));
  const clientTools = options.request.tools ?? [];

  for (let turn = 0; turn <= maxTurns; turn++) {
    const openAiRequest = toOpenAiRequest(
      { ...options.request, messages },
      { model: options.model, features: options.features },
    );

    // The MCP server's tools are offered alongside the client's own.
    if (options.mcpTools?.length) {
      openAiRequest.tools = [
        ...(openAiRequest.tools ?? []),
        ...options.mcpTools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema as Record<string, unknown>,
          },
        })),
      ];
    }

    const collected: CollectedToolCall[] = [];
    let sawToolCall = false;
    let pendingIndex = 0;
    let pendingId = "";
    let pendingName = "";
    let pendingArgs = "";

    for await (const event of options.stream(openAiRequest)) {
      switch (event.kind) {
        case "tool_start": {
          sawToolCall = true;
          pendingIndex = event.index;
          pendingId = event.id;
          pendingName = event.name;
          pendingArgs = "";
          break;
        }
        case "tool_args": {
          if (event.index === pendingIndex) pendingArgs += event.partialJson;
          break;
        }
        case "tool_end": {
          if (event.index === pendingIndex) {
            collected.push({ id: pendingId, name: pendingName, arguments: pendingArgs });
          }
          break;
        }
        default:
          break;
      }
      // Everything except the tool calls is passed straight through.
      if (event.kind !== "tool_start" && event.kind !== "tool_args" && event.kind !== "tool_end") {
        yield event;
      }
    }

    if (!sawToolCall || collected.length === 0) {
      // The model finished without asking for a tool.
      return;
    }

    // Split the calls: ours to execute, the client's to return.
    const ours = collected.filter((c) => mcpToolNames.has(c.name));
    const theirs = collected.filter((c) => !mcpToolNames.has(c.name));

    if (theirs.length > 0) {
      // A tool the client declared: hand the call back the normal way.
      for (const call of theirs) {
        yield { kind: "tool_start", index: 0, id: call.id, name: call.name };
        if (call.arguments) yield { kind: "tool_args", index: 0, partialJson: call.arguments };
        yield { kind: "tool_end", index: 0 };
      }
      yield { kind: "finish", stopReason: "tool_use", stopSequence: null };
      return;
    }

    if (!options.mcp) {
      return;
    }

    // Execute our tools and feed the results back.
    const toolResults: ToolResultBlock[] = [];
    for (const call of ours) {
      let args: Record<string, unknown> = {};
      if (call.arguments.trim() !== "") {
        try {
          args = JSON.parse(call.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
      }
      options.onToolCall?.(call.name, args);

      let result: { content: Array<Record<string, unknown>>; isError?: boolean };
      try {
        result = await options.mcp.callTool(call.name, args);
      } catch (err) {
        result = {
          content: [
            {
              type: "text",
              text: `Tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }

      const text = result.content
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .filter(Boolean)
        .join("\n");

      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: text || "(no output)",
        ...(result.isError ? { is_error: true } : {}),
      });
    }

    // Continue the conversation with the tool results.
    const assistantTurn: MessageParam = {
      role: "assistant",
      content: ours.map((c) => ({
        type: "tool_use" as const,
        id: c.id,
        name: c.name,
        input: (() => {
          try {
            return JSON.parse(c.arguments || "{}") as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
      })),
    };
    const userTurn: MessageParam = { role: "user", content: toolResults };
    messages = [...messages, assistantTurn, userTurn];
  }

  yield { kind: "finish", stopReason: "end_turn", stopSequence: null };
}
