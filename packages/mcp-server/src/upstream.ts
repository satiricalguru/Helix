/**
 * An upstream MCP connector.
 *
 * Helix's MCP server can sit between a real MCP client (Claude, ChatGPT) and
 * an upstream generation server (Higgsfield). When it does, it forwards the
 * **connected client's own identity** rather than claiming one of its own, so
 * the upstream sees the client that is genuinely making the tool calls.
 *
 * That is what makes Helix a connector rather than a disguise: the Claude app
 * really is the agent, and Helix is the plumbing in between.
 */

import { McpClient, type CallOptions, type ClientIdentity, type McpToolDescriptor } from "@helix/mcp-client";

export interface UpstreamConnectorOptions {
  url: string;
  /** The token Helix presents to the upstream. */
  token?: string;
  protocolVersion?: string;
  timeoutMs?: number;
}

export class UpstreamConnector {
  #client: McpClient;

  constructor(opts: UpstreamConnectorOptions) {
    this.#client = new McpClient({
      url: opts.url,
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.protocolVersion ? { protocolVersion: opts.protocolVersion } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  get url(): string {
    return this.#client.url;
  }
  /** List the upstream's tools, as the connected client. */
  async listTools(clientInfo?: ClientIdentity): Promise<McpToolDescriptor[]> {
    return this.#client.listTools(clientInfo ? { clientInfo } : {});
  }

  /** Call an upstream tool, forwarding the connected client's identity. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { clientInfo?: ClientIdentity; token?: string } = {},
  ): Promise<{
    content: Array<Record<string, unknown>>;
    isError?: boolean;
    structuredContent?: unknown;
  }> {
    const callOptions: CallOptions = {};
    if (options.clientInfo) callOptions.clientInfo = options.clientInfo;
    if (options.token) callOptions.token = options.token;
    return this.#client.callTool(name, args, callOptions);
  }
}
