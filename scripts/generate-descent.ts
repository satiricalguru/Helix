/**
 * Generate the four-clip descent film on Higgsfield.
 *
 * The chain:
 *
 *   this script -> Helix gateway (Anthropic Messages API)
 *                    -> local model (Ollama, ornith-1.5:9b) plans the shot
 *                    -> Helix MCP client -> https://mcp.higgsfield.ai/mcp
 *                    -> Seedance 2.5 renders the clip
 *
 * The local model is the planner; Higgsfield renders. Nothing about the
 * request is fabricated: the model is told what it is doing, and the tool
 * calls are real.
 *
 *   pnpm tsx scripts/generate-descent.ts            # quote only, spends nothing
 *   pnpm tsx scripts/generate-descent.ts --render    # actually generate
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createApp } from "@helix/gateway";
import { KeyStore, mintKey, ModelRouter } from "@helix/gateway";
import { ThinkingSigner, LocalModelClient } from "@helix/local-adapter";
import { DEFAULT_MODEL_GROUPS, type ModelGroup } from "@helix/config";
import { InMemoryQuotaStore, QuotaService } from "@helix/quota";
import { McpClient } from "@helix/mcp-client";

/* ------------------------------------------------------------- brief */

const MASTER_STYLE =
  "Photorealistic nature cinematography, shot on a cinema camera with an anamorphic macro lens. " +
  "One single continuous unbroken camera move, no cuts, no text, no people, no logos, no UI. " +
  "Physically accurate light, real dew refraction, subsurface scattering in leaves, shallow depth of field with natural focus pulls, " +
  "subtle handheld micro-motion, 24fps filmic motion blur. " +
  "Forest palette: deep greens, earthy browns, soft gold sunlight, restrained highlights. " +
  "Cave palette: turquoise, emerald, cyan crystal light against dark warm stone. " +
  "No morphing, no warping, no flickering, no cartoon or CGI look.";

interface Clip {
  index: number;
  title: string;
  seconds: number;
  body: string;
  /** The last frame of the previous clip, for start-frame chaining. */
  continuesFrom?: number;
}

const CLIPS: Clip[] = [
  {
    index: 1,
    title: "The forest",
    seconds: 12,
    body:
      "Dawn in an untouched old-growth forest. The camera starts wide, low and slow, drifting forward just above the forest floor. " +
      "Enormous trees, volumetric god rays through light mist, drifting pollen glittering in the beams. " +
      "Grass and tiny wildflowers sway in a gentle breeze, moss on roots, dew on every blade. " +
      "A small butterfly crosses very close to the lens. The camera descends steadily toward a patch of tall grass, " +
      "with smooth ease-in acceleration. Ends with the lens sinking into the grass line, blades filling the frame edges.",
  },
  {
    index: 2,
    title: "Into the grass",
    seconds: 12,
    continuesFrom: 1,
    body:
      "Continue from the previous frame. Macro scale: the camera glides forward and downward between giant grass blades that tower overhead like columns. " +
      "Dew droplets with real reflections of the sky, one droplet rolls slowly down a blade. " +
      "The camera slips between two enormous overlapping leaves, tiny insects and spores drifting through shafts of light, soil grains and roots visible below. " +
      "Deep shallow focus, foreground blades blur past. The ground opens ahead into a dark, mossy gap in the earth. Ends facing the cave mouth.",
  },
  {
    index: 3,
    title: "Threshold",
    seconds: 10,
    continuesFrom: 2,
    body:
      "Continue from the previous frame. The camera moves through a narrow mossy opening between roots and stone. " +
      "Warm sunlight behind us fades as the lens enters shadow, then faint turquoise glow appears ahead: " +
      "bioluminescent moss on wet rock, glowing spores floating upward, crystals embedded in the walls lighting up one after another as the camera passes. " +
      "Water drips and shimmers on stone. Exposure adapts like a real camera, brightening slowly toward the glow. " +
      "Ends at the edge of an opening into a vast space.",
  },
  {
    index: 4,
    title: "The reveal",
    seconds: 15,
    continuesFrom: 3,
    body:
      "Continue from the previous frame. The camera glides out of the tunnel and rises into an immense, luminous cavern, the climax of the film. " +
      "Towering rock formations, translucent crystal clusters glowing cyan and emerald, bioluminescent flowers opening in clusters, " +
      "glowing turquoise moss on every ledge, an underground waterfall crashing into crystal-clear water with fine mist, ripples and splashes, " +
      "reflections on wet stone, thousands of tiny luminous particles floating in the air. " +
      "The camera pulls back and tilts up slowly to reveal the full scale of the cave. Awe, bright and magical, not dark or frightening. " +
      "Hold the final wide frame for the last second.",
  },
];

const AUDIO =
  "Audio: wind and birdsong, fading into deep reverb, dripping water and a soft low synth pad in the cave, a waterfall roar swelling at the reveal.";

const MODEL = "seedance_2_5";
const RESOLUTION = process.env.HELIX_CLIP_RESOLUTION ?? "1080p";
const ASPECT = process.env.HELIX_CLIP_ASPECT ?? "16:9";
const OLLAMA_BASE = process.env.HELIX_LOCAL_BASE_URL ?? "http://127.0.0.1:11434/v1";
const OLLAMA_MODEL = process.env.HELIX_LOCAL_MODEL ?? "ornith-1.5:9b";
const HF_MCP_URL = "https://mcp.higgsfield.ai/mcp";
const TOKEN_FILE = path.join(homedir(), ".config", "helix", "higgsfield-token.json");
const OUT_DIR = path.resolve(process.cwd(), "site/public/video");
const MANIFEST = path.resolve(process.cwd(), "site/public/video/manifest.json");

/** Only these upstream tools are offered to the local model. */
const TOOL_ALLOWLIST = ["generate_video", "models_explore", "job_status", "balance"];

/* -------------------------------------------------------------- setup */

async function higgsfieldToken(): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(TOKEN_FILE, "utf8")) as {
      access_token: string;
      expires_at: number;
    };
    if (raw.expires_at > Date.now()) return raw.access_token;
    console.warn("[descent] the cached Higgsfield token has expired; run scripts/higgsfield-auth.ts");
    process.exit(1);
  } catch {
    console.error("[descent] no Higgsfield token. Run: pnpm tsx scripts/higgsfield-auth.ts");
    process.exit(1);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface ClipResult {
  index: number;
  title: string;
  seconds: number;
  prompt: string;
  status: "rendered" | "quoted" | "failed";
  urls: string[];
  message: string;
}

/* --------------------------------------------------------------- main */

async function main(): Promise<void> {
  const render = process.argv.includes("--render");
  /** `local` lets the model plan; `direct` sends the exact brief verbatim. */
  const planner = process.argv.includes("--direct") ? "direct" : "local";
  const token = await higgsfieldToken();

  console.log(`[descent] upstream MCP: ${HF_MCP_URL}`);
  console.log(`[descent] planner: ${planner === "local" ? `${OLLAMA_MODEL} @ ${OLLAMA_BASE}` : "direct (exact prompt)"}`);
  console.log(`[descent] model: ${MODEL} · ${RESOLUTION} · ${ASPECT}`);
  console.log(`[descent] mode: ${render ? "RENDER (spends credits)" : "QUOTE (spends nothing)"}\n`);

  const upstream = new McpClient({
    url: HF_MCP_URL,
    token,
    // Higgsfield's server speaks the modern revision. It rejects a legacy
    // `_meta.protocolVersion` outright, even though its legacy path (no
    // `_meta` at all) still works.
    protocolVersion: "2026-07-28",
    timeoutMs: 900_000,
  });

  // Establish the upstream session and pick the tools to expose.
  //
  // In the 2026-07-28 revision `initialize` was removed: the server is
  // stateless and every request carries the version in `_meta`. Higgsfield
  // serves both eras, so the modern path is simply "no handshake".
  const upstreamTools = await upstream.listTools({
    clientInfo: { name: "helix", title: "Helix", version: "0.1.0" },
  });
  const exposed = upstreamTools
    .filter((t) => TOOL_ALLOWLIST.includes(t.name))
    .map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.inputSchema as { type: "object"; properties?: Record<string, unknown> },
    }));
  console.log(`[descent] offering ${exposed.length} tool(s) to the planner: ${exposed.map((t) => t.name).join(", ")}\n`);

  const { key, secret } = mintKey({ tenantId: "descent", label: "descent" });
  const groups: ModelGroup[] = DEFAULT_MODEL_GROUPS.map((g) => ({
    ...g,
    deployments: g.deployments.map((d) => ({ ...d, baseUrl: OLLAMA_BASE, model: OLLAMA_MODEL })),
  }));

  const app = createApp({
    groups,
    keys: new KeyStore([key]),
    router: new ModelRouter(groups),
    quota: new QuotaService(new InMemoryQuotaStore()),
    signer: new ThinkingSigner("descent-signing-secret"),
    mcpClient: upstream,
    mcpTools: exposed,
    clientFor: (deployment) =>
      new LocalModelClient({
        baseUrl: deployment.baseUrl,
        model: deployment.model,
        numCtx: Number(process.env.HELIX_LOCAL_NUM_CTX ?? 32768),
        timeoutMs: 900_000,
      }),
    featuresFor: (d) => ({
      reasoningEffort: d.supportsReasoningEffort,
      jsonSchema: d.supportsJsonSchema,
      parallelToolCalls: true,
    }),
    logger: { error: (m, e) => console.error(m, e) },
  });

  const results: ClipResult[] = [];

  for (const clip of CLIPS) {
    const prompt = `${MASTER_STYLE} ${clip.body} ${AUDIO}`;
    const started = Date.now();

    // The exact upstream arguments. Both planners send these, so a chained
    // clip cannot drift because a model paraphrased the brief.
    const baseArgs = {
      model: MODEL,
      prompt,
      duration: clip.seconds,
      resolution: RESOLUTION,
      aspect_ratio: ASPECT,
      generate_audio: true,
      ...(render ? {} : { get_cost: true }),
    };

    // Ask for the unlimited allowance first. The backend answers with a typed
    // rejection rather than a charge when the account has none, so it is safe
    // to always try. When it is refused because Helix is not a Claude or
    // ChatGPT client, fall back to paying with credits.
    const unlimRefusal = /not available in the app you are using|part of the Higgsfield free trial/i;
    let args: Record<string, unknown> = { ...baseArgs, use_unlim: true };
    if (process.argv.includes("--credits")) args = baseArgs;

    console.log(`--- clip ${clip.index}/4: ${clip.title} (${clip.seconds}s) ---`);

    let answer = "";
    let error: string | undefined;

    if (planner === "direct") {
      let result = await upstream.callTool(
        "generate_video",
        { params: args },
        { clientInfo: { name: "helix", title: "Helix", version: "0.1.0" } },
      );
      answer = (result.content ?? [])
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("\n");
      if (result.isError && unlimRefusal.test(answer) && !process.argv.includes("--credits")) {
        console.log("    (no unlimited allowance for this client — falling back to credits)");
        result = await upstream.callTool(
          "generate_video",
          { params: baseArgs },
          { clientInfo: { name: "helix", title: "Helix", version: "0.1.0" } },
        );
        answer = (result.content ?? [])
          .map((c) => (typeof c.text === "string" ? c.text : ""))
          .join("\n");
      }
      if (result.isError) error = answer;
    } else {
      const instruction =
        `Use the generate_video tool exactly once to render clip ${clip.index} of 4: "${clip.title}". ` +
        `Use model "${MODEL}", duration ${clip.seconds}, resolution "${RESOLUTION}", aspect_ratio "${ASPECT}". ` +
        (clip.continuesFrom
          ? `This continues clip ${clip.continuesFrom}; keep the same look and lighting. `
          : "") +
        `Use exactly this prompt text for the tool's prompt field:\n\n${prompt}` +
        (render ? "" : ` Do not actually generate yet — only report the cost.`);

      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          model: groups[0]!.advertisedId,
          max_tokens: 900,
          messages: [{ role: "user", content: instruction }],
        }),
      });

      const text = await res.text();
      let body: { content?: Array<{ type: string; text?: string }>; error?: { message: string } };
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: { message: text.slice(0, 300) } };
      }
      answer = (body.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if (body.error) error = body.error.message;
    }

    const urls = [...answer.matchAll(/https?:\/\/[^\s"'<>]+\.(?:mp4|mov|webm|m4v)/gi)].map((m) => m[0]);

    if (error) {
      console.log(`    blocked: ${error.slice(0, 220)}`);
      results.push({
        index: clip.index,
        title: clip.title,
        seconds: clip.seconds,
        prompt,
        status: "failed",
        urls: [],
        message: error,
      });
      continue;
    }

    console.log(`    ${((Date.now() - started) / 1000).toFixed(1)}s`);
    for (const line of answer.split("\n").filter(Boolean).slice(0, 6)) {
      console.log(`    | ${line.slice(0, 200)}`);
    }
    if (urls.length > 0) console.log(`    urls: ${urls.join(", ")}`);

    results.push({
      index: clip.index,
      title: clip.title,
      seconds: clip.seconds,
      prompt,
      status: urls.length > 0 ? "rendered" : "quoted",
      urls,
      message: answer.slice(0, 2000),
    });
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    MANIFEST,
    `${JSON.stringify(
      {
        title: "Descent",
        model: MODEL,
        resolution: RESOLUTION,
        aspectRatio: ASPECT,
        masterStyle: MASTER_STYLE,
        generatedAt: new Date().toISOString(),
        clips: results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n[descent] manifest written to ${MANIFEST}`);

  const rendered = results.filter((r) => r.status === "rendered");
  if (rendered.length === results.length) {
    console.log("[descent] every clip rendered. Next: stitch and keyframe-encode.");
    console.log(
      "[descent]   ffmpeg -i clip1.mp4 -i clip2.mp4 -i clip3.mp4 -i clip4.mp4 -filter_complex concat=n=4:v=1:a=0 -g 1 -c:v libx264 -crf 20 -an descent.mp4",
    );
  } else {
    console.log(`[descent] ${rendered.length}/${results.length} clips rendered.`);
  }
}

main().catch((err) => {
  console.error("[descent] failed", err);
  process.exit(1);
});

export { CLIPS, MASTER_STYLE, sha256 };
