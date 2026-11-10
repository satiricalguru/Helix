/**
 * Gateway entry point.
 *
 * Environment:
 *   HELIX_GATEWAY_PORT          listen port (default 4000)
 *   HELIX_ADVERTISE_MODEL_ID    the advertised model id (default helix-fable-5-2)
 *   HELIX_LOCAL_BASE_URL        OpenAI-compatible server (default http://127.0.0.1:11434/v1)
 *   HELIX_LOCAL_MODEL           upstream model name (default qwen3:32b)
 *   HELIX_API_KEY               a virtual key; one is generated when absent
 *   HELIX_SIGNING_SECRET        secret for synthetic thinking signatures
 *   HELIX_REDIS_URL             enables the shared Redis quota store
 *   HELIX_MEDIA_BUDGET_USD      daily media spend budget per key (default 10)
 */

import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { DEFAULT_MODEL_GROUPS, type ModelGroup } from "@helix/config";
import { InMemoryQuotaStore, QuotaService, RedisQuotaStore, type QuotaStore } from "@helix/quota";
import { LocalModelClient, ThinkingSigner } from "@helix/local-adapter";
import type { Tool } from "@helix/contracts";
import { createApp } from "./app.js";
import { KeyStore, mintKey } from "./keys.js";
import { ModelRouter } from "./router.js";
import { McpClient } from "./mcp-client.js";

async function buildQuotaStore(): Promise<QuotaStore> {
  const url = process.env.HELIX_REDIS_URL;
  if (!url) {
    console.warn(
      "[gateway] HELIX_REDIS_URL is not set; using the in-memory quota store. " +
        "Rate limits and budgets are per process and are lost on restart.",
    );
    return new InMemoryQuotaStore();
  }
  const mod = (await import("ioredis")) as unknown as {
    default: new (url: string) => unknown;
  };
  const redis = new mod.default(url);
  return new RedisQuotaStore(redis as never);
}

async function main() {
  const port = Number(process.env.HELIX_GATEWAY_PORT ?? 4000);
  const signingSecret =
    process.env.HELIX_SIGNING_SECRET ?? "helix-development-signing-secret-change-me";

  const keys = new KeyStore();
  const envKey = process.env.HELIX_API_KEY;
  if (envKey) {
    // A pre-set key is stored by hash only.
    keys.add({
      id: "sk-helix-env",
      hash: createHash("sha256").update(envKey, "utf8").digest("hex"),
      tenantId: "default",
      label: "env",
      allowedModels: "*",
      rpm: Number(process.env.HELIX_RPM ?? 120),
      maxConcurrent: Number(process.env.HELIX_MAX_CONCURRENT ?? 8),
      dailyUsdBudget: Number(process.env.HELIX_MEDIA_BUDGET_USD ?? 10),
    });
  } else {
    const minted = mintKey({ tenantId: "default", label: "development" });
    keys.add(minted.key);
    console.log(`[gateway] generated a development key: ${minted.secret}`);
  }

  const groups: ModelGroup[] = DEFAULT_MODEL_GROUPS;
  const router = new ModelRouter(groups);
  const quota = new QuotaService(await buildQuotaStore());

  // Studio mode: the local model becomes the planner and drives the MCP
  // server's generation tools itself.
  const mcpUrl = process.env.HELIX_MCP_URL;
  let mcpClient: McpClient | undefined;
  let mcpTools: Tool[] | undefined;
  if (mcpUrl) {
    mcpClient = new McpClient({
      url: mcpUrl,
      ...(process.env.HELIX_MCP_TOKEN ? { token: process.env.HELIX_MCP_TOKEN } : {}),
      timeoutMs: Number(process.env.HELIX_MCP_TIMEOUT_MS ?? 900_000),
    });
    try {
      mcpTools = (await mcpClient.listTools()).map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        input_schema: t.inputSchema as { type: "object"; properties?: Record<string, unknown> },
      }));
      console.log(`[gateway] Studio mode: ${mcpTools.length} tool(s) from ${mcpUrl}`);
    } catch (err) {
      console.error(`[gateway] could not list tools from ${mcpUrl}:`, err);
      mcpClient = undefined;
    }
  }

  const app = createApp({
    groups,
    keys,
    router,
    quota,
    signer: new ThinkingSigner(signingSecret),
    ...(mcpClient ? { mcpClient } : {}),
    ...(mcpTools ? { mcpTools } : {}),
    clientFor: (deployment) =>
      new LocalModelClient({
        baseUrl: deployment.baseUrl,
        model: deployment.model,
        ...(deployment.numCtx ? { numCtx: deployment.numCtx } : {}),
        timeoutMs: Number(process.env.HELIX_UPSTREAM_TIMEOUT_MS ?? 300_000),
      }),
    featuresFor: (deployment) => ({
      reasoningEffort: deployment.supportsReasoningEffort,
      jsonSchema: deployment.supportsJsonSchema,
      parallelToolCalls: true,
    }),
    logger: { error: (message, error) => console.error(message, error) },
  });

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[gateway] listening on http://127.0.0.1:${info.port}`);
    console.log(`[gateway] model: ${groups[0]!.advertisedId}`);
  });
}

main().catch((err) => {
  console.error("[gateway] failed to start", err);
  process.exit(1);
});
