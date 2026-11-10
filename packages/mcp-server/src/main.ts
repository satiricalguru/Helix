/**
 * MCP server entry point.
 *
 * Environment:
 *   HELIX_MCP_PORT            listen port (default 4001)
 *   HELIX_PUBLIC_URL         the public base URL, e.g. https://helix.example
 *   HELIX_HF_KEY_ID          Higgsfield API key id
 *   HELIX_HF_KEY_SECRET      Higgsfield API key secret
 *   HELIX_WEBHOOK_SECRET     shared secret Higgsfield signs webhooks with
 *   HELIX_ALLOWED_ORIGINS    comma-separated list of allowed Origin values
 *   HELIX_REDIS_URL          enables the shared Redis quota store
 *   HELIX_MEDIA_BUDGET_USD   daily media spend budget per tenant (default 10)
 */

import { serve } from "@hono/node-server";
import { DEFAULT_HF_CATALOG } from "@helix/config";
import { HfClient } from "@helix/hf-client";
import { InMemoryQuotaStore, QuotaService, RedisQuotaStore, type QuotaStore } from "@helix/quota";
import { createMcpApp } from "./http.js";
import { InMemoryUserStore, JsonFileUserStore, OAuthServer, hashPassword } from "./oauth.js";
import { McpServer } from "./server.js";
import { TaskStore } from "./tasks.js";
import { buildTools, buildRelayTools } from "./tools.js";
import { UpstreamConnector } from "./upstream.js";

async function buildQuotaStore(): Promise<QuotaStore> {
  const url = process.env.HELIX_REDIS_URL;
  if (!url) {
    console.warn(
      "[mcp] HELIX_REDIS_URL is not set; using the in-memory quota store. " +
        "Budgets are per process and are lost on restart.",
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
  const port = Number(process.env.HELIX_MCP_PORT ?? 4001);
  const publicUrl = (process.env.HELIX_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(
    /\/$/,
    "",
  );
  const resource = `${publicUrl}/mcp`;

  const keyId = process.env.HELIX_HF_KEY_ID;
  const keySecret = process.env.HELIX_HF_KEY_SECRET;
  const hf =
    keyId && keySecret
      ? new HfClient({ credentials: { keyId, keySecret } })
      : undefined;
  if (!hf) {
    console.warn(
      "[mcp] HELIX_HF_KEY_ID / HELIX_HF_KEY_SECRET are not set; " +
        "generation tools will report that generation is unavailable.",
    );
  }

  const quota = new QuotaService(await buildQuotaStore());
  const dailyUsdBudget = Number(process.env.HELIX_MEDIA_BUDGET_USD ?? 10);

  // Connector mode: relay to an upstream generation MCP server (Higgsfield),
  // forwarding the connected client's identity. When this is set, the
  // generation tools go upstream instead of calling the Higgsfield API
  // directly.
  const upstreamUrl = process.env.HELIX_UPSTREAM_MCP_URL;
  let upstream: UpstreamConnector | undefined;
  if (upstreamUrl) {
    upstream = new UpstreamConnector({
      url: upstreamUrl,
      ...(process.env.HELIX_UPSTREAM_MCP_TOKEN
        ? { token: process.env.HELIX_UPSTREAM_MCP_TOKEN }
        : {}),
      protocolVersion: process.env.HELIX_UPSTREAM_MCP_PROTOCOL ?? "2026-07-28",
      timeoutMs: Number(process.env.HELIX_UPSTREAM_MCP_TIMEOUT_MS ?? 900_000),
    });
    console.log(`[mcp] connector mode: relaying generation to ${upstreamUrl}`);
  }

  const tools = upstream
    ? buildRelayTools({
        upstream,
        // Higgsfield nests every model parameter under `params`.
        ...(process.env.HELIX_UPSTREAM_MCP_PARAM_WRAPPER ?? "params"
          ? { paramWrapper: process.env.HELIX_UPSTREAM_MCP_PARAM_WRAPPER ?? "params" }
          : {}),
      })
    : buildTools({
        hf,
        catalog: DEFAULT_HF_CATALOG,
        quota,
        dailyUsdBudget,
      });

  const server = new McpServer({
    name: "helix",
    version: "0.1.0",
    instructions:
      "Helix generates images and video. The tools here call the Higgsfield " +
      "generation API; outputs are AI-generated and consume credits. You may " +
      "call list_generation_models first to see what is available.",
    tools,
    resources: [
      {
        uri: "helix://models",
        name: "Generation models",
        title: "Generation models",
        description: "The catalog of video and image models Helix can drive.",
        mimeType: "application/json",
        read: async () => [
          {
            uri: "helix://models",
            mimeType: "application/json",
            text: JSON.stringify(DEFAULT_HF_CATALOG, null, 2),
          },
        ],
      },
    ],
    prompts: [
      {
        name: "aura-edit",
        title: "Aura edit",
        description: "Recreate an aura edit from a reference video.",
        arguments: [
          { name: "reference", description: "Public URL of the reference video", required: true },
          { name: "subject", description: "Optional subject description" },
        ],
        get: async (args) => ({
          description: "Aura edit",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text:
                  `Create an aura edit from ${args.reference ?? "the reference video"}` +
                  (args.subject ? ` featuring ${args.subject}` : "") +
                  ". Use the generate_video tool.",
              },
            },
          ],
        }),
      },
    ],
    tasks: new TaskStore(),
    enableTasks: true,
    onToolCall: (name, args) => {
      // Audit log: which tool, from whom, with what arguments.
      console.log(
        `[mcp] tool ${name} ` +
          JSON.stringify(args).slice(0, 300),
      );
    },
  });

  const oauth = new OAuthServer({ issuer: publicUrl, resource });

  // Accounts live in a JSON file so they survive restarts. When no file is
  // configured the store is in-memory and a bootstrap account can be seeded
  // from the environment.
  const usersFile = process.env.HELIX_USERS_FILE;
  const users = usersFile
    ? await JsonFileUserStore.open(usersFile)
    : new InMemoryUserStore();

  const bootstrapEmail = process.env.HELIX_BOOTSTRAP_USER_EMAIL;
  const bootstrapPassword = process.env.HELIX_BOOTSTRAP_USER_PASSWORD;
  if (bootstrapEmail && bootstrapPassword) {
    const existing = await users.findByEmail(bootstrapEmail);
    if (!existing) {
      await users.create(bootstrapEmail, hashPassword(bootstrapPassword));
      console.log(`[mcp] created the bootstrap account ${bootstrapEmail}`);
    }
  } else if (!usersFile) {
    console.warn(
      "[mcp] no users file and no bootstrap account; nobody can sign in. " +
        "Set HELIX_USERS_FILE (or HELIX_BOOTSTRAP_USER_EMAIL and " +
        "HELIX_BOOTSTRAP_USER_PASSWORD) and run `helix user add <email>`.",
    );
  }

  const app = createMcpApp({
    server,
    oauth,
    users,
    publicUrl,
    ...(hf ? { hf } : {}),
    ...(process.env.HELIX_WEBHOOK_SECRET
      ? { webhookSecret: process.env.HELIX_WEBHOOK_SECRET }
      : {}),
    ...(process.env.HELIX_ALLOWED_ORIGINS
      ? { allowedOrigins: process.env.HELIX_ALLOWED_ORIGINS.split(",").map((s) => s.trim()) }
      : {}),
    logger: { error: (message, error) => console.error(message, error) },
  });

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[mcp] listening on http://127.0.0.1:${info.port}`);
    console.log(`[mcp] MCP endpoint: ${resource}`);
    console.log(`[mcp] OAuth issuer: ${publicUrl}`);
  });
}

main().catch((err) => {
  console.error("[mcp] failed to start", err);
  process.exit(1);
});
