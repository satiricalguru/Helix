#!/usr/bin/env node
/**
 * `helix` developer CLI.
 *
 * Commands:
 *   helix doctor        check the local model, Higgsfield and Redis
 *   helix models        list the models Helix serves and the generation catalog
 *   helix key           mint a virtual key
 */

import { randomBytes } from "node:crypto";
import { DEFAULT_HF_CATALOG, DEFAULT_MODEL_GROUPS, estimateCost, findHfModel } from "@helix/config";
import { HfClient } from "@helix/hf-client";
import { mintKey } from "@helix/gateway";

const bold = (s: string) => `[1m${s}[0m`;
const green = (s: string) => `[32m${s}[0m`;
const red = (s: string) => `[31m${s}[0m`;
const dim = (s: string) => `[2m${s}[0m`;

async function doctor(): Promise<number> {
  console.log(bold("Helix doctor"));
  console.log(dim("─".repeat(60)));
  let failures = 0;

  /* ---------------------------------------------------- local model */
  const baseUrl = process.env.HELIX_LOCAL_BASE_URL ?? "http://127.0.0.1:11434/v1";
  const model = process.env.HELIX_LOCAL_MODEL ?? "qwen3:32b";
  process.stdout.write(`local model   ${baseUrl} (${model}) ... `);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id).filter(Boolean);
    console.log(green("ok"));
    if (ids.length > 0) {
      console.log(dim(`  available: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? " ..." : ""}`));
    } else {
      console.log(dim("  (the server responded but listed no models)"));
    }
    if (ids.length > 0 && !ids.includes(model)) {
      console.log(
        red(`  warning: "${model}" is not in the list; set HELIX_LOCAL_MODEL to one of the above`),
      );
    }
  } catch (err) {
    failures++;
    console.log(red("unreachable"));
    console.log(dim(`  ${err instanceof Error ? err.message : String(err)}`));
  }

  /* ----------------------------------------------------- higgsfield */
  const keyId = process.env.HELIX_HF_KEY_ID;
  const keySecret = process.env.HELIX_HF_KEY_SECRET;
  process.stdout.write("higgsfield   ");
  if (!keyId || !keySecret) {
    console.log(dim("not configured (generation tools will report unavailable)"));
  } else {
    console.log(dim("checking..."));
    try {
      const hf = new HfClient({ credentials: { keyId, keySecret } });
      // There is no cheap read endpoint; a bad credential fails on any call.
      const res = await fetch("https://api.higgsfield.ai/requests/nonexistent/status", {
        headers: { authorization: `Key ${keyId}:${keySecret}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401) {
        failures++;
        console.log(red("  the credential was rejected"));
      } else {
        console.log(green("  the credential was accepted"));
      }
    } catch (err) {
      failures++;
      console.log(red("  unreachable"));
      console.log(dim(`  ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /* ---------------------------------------------------------- redis */
  const redisUrl = process.env.HELIX_REDIS_URL;
  process.stdout.write("redis        ");
  if (!redisUrl) {
    console.log(dim("not configured (in-memory quotas)"));
  } else {
    try {
      const mod = (await import("ioredis")) as unknown as {
        default: new (url: string, opts?: Record<string, unknown>) => {
          connect(): Promise<void>;
          ping(): Promise<string>;
          quit(): Promise<void>;
        };
      };
      const redis = new mod.default(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redis.connect();
      await redis.ping();
      await redis.quit();
      console.log(green("ok"));
    } catch (err) {
      failures++;
      console.log(red("unreachable"));
      console.log(dim(`  ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /* --------------------------------------------------------- config */
  console.log(dim("─".repeat(60)));
  console.log(`served model: ${DEFAULT_MODEL_GROUPS[0]!.advertisedId}`);
  console.log(`upstream:     ${DEFAULT_MODEL_GROUPS[0]!.deployments[0]!.model}`);
  console.log(`generation:   ${DEFAULT_HF_CATALOG.length} models in the catalog`);
  if (failures > 0) {
    console.log(red(`\n${failures} check(s) failed`));
    return 1;
  }
  console.log(green("\nall checks passed"));
  return 0;
}

function models(): void {
  console.log(bold("Served models"));
  console.log(dim("─".repeat(60)));
  for (const group of DEFAULT_MODEL_GROUPS) {
    console.log(`${group.advertisedId}`);
    console.log(dim(`  ${group.displayName}`));
    console.log(dim(`  ${group.disclosure}`));
    for (const d of group.deployments) {
      console.log(dim(`  -> ${d.provider}:${d.model} @ ${d.baseUrl}`));
    }
  }
  console.log("");
  console.log(bold("Generation catalog"));
  console.log(dim("─".repeat(60)));
  for (const m of DEFAULT_HF_CATALOG) {
    const unit = m.unit === "second" ? "/s" : `/${m.unit}`;
    console.log(`${m.endpointId}`);
    console.log(
      dim(
        `  ${m.name} — ${m.provider} — $${m.unitPriceUsd.toFixed(3)}${unit}` +
          (m.duration ? ` — ${m.duration.min}-${m.duration.max}s` : ""),
      ),
    );
  }
}

function key(): void {
  const minted = mintKey({
    tenantId: process.env.HELIX_TENANT ?? "default",
    label: process.env.HELIX_KEY_LABEL ?? "cli",
    allowedModels: (process.env.HELIX_KEY_MODELS ?? "*").split(","),
    rpm: Number(process.env.HELIX_RPM ?? 120),
    maxConcurrent: Number(process.env.HELIX_MAX_CONCURRENT ?? 8),
    dailyUsdBudget: Number(process.env.HELIX_MEDIA_BUDGET_USD ?? 10),
  });
  console.log(`key id:  ${minted.key.id}`);
  console.log(`secret:  ${minted.secret}`);
  console.log(dim("Store the secret now; only its hash is kept."));
}

async function userAdd(email: string, password?: string): Promise<void> {
  const path = process.env.HELIX_USERS_FILE;
  if (!path) {
    console.error(
      "HELIX_USERS_FILE is not set. Point it at a JSON file the MCP server can read, " +
        "e.g. HELIX_USERS_FILE=./data/users.json",
    );
    process.exit(1);
  }
  const { JsonFileUserStore, hashPassword } = await import("@helix/mcp-server");
  const store = await JsonFileUserStore.open(path);
  const existing = await store.findByEmail(email);
  if (existing) {
    console.error(`An account already exists for ${email}.`);
    process.exit(1);
  }
  const secret = password ?? randomBytes(12).toString("base64url");
  await store.create(email, hashPassword(secret));
  console.log(`created ${email}`);
  if (!password) {
    console.log(`password: ${secret}`);
    console.log(dim("Store it now; only its hash is written to disk."));
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "doctor";
  switch (command) {
    case "doctor":
      process.exit(await doctor());
      break;
    case "models":
      models();
      break;
    case "key":
      key();
      break;
    case "user":
      await userAdd(process.argv[3] ?? "", process.argv[4]);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: helix <doctor|models|key|user>");
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { estimateCost, findHfModel };
