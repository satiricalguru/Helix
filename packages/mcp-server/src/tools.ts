/**
 * The generation tools Helix exposes over MCP.
 *
 * Every tool that spends money states its cost in the description and in the
 * result, and every tool that produces media states that the output is
 * AI-generated. Both are required by the disclosure rules in the plan.
 */

import type { HfModelSpec, McpTool, ToolAnnotations } from "@helix/contracts";
import { estimateCost, findHfModel } from "@helix/config";
import type { HfClient } from "@helix/hf-client";
import { isTerminal, outputUrls } from "@helix/hf-client";
import type { QuotaService } from "@helix/quota";
import type { UpstreamConnector } from "./upstream.js";

export interface ToolRunContext {
  /** The tenant this call is billed to. */
  subject: string;
  /** Progress sink; no-op when the client did not supply a progress token. */
  progress: (progress: number, total: number | undefined, message: string) => void;
  /** Aborts when the client cancels or the connection drops. */
  signal: AbortSignal;
  /** A unique id used to make the submission idempotent. */
  idempotencyKey: string;
  /**
   * The identity of the client that is actually connected.
   *
   * Forwarded to an upstream generation server so it sees the real client
   * rather than Helix. Absent when the caller is Helix's own gateway.
   */
  clientInfo?: { name: string; title?: string; version?: string };
  /** The upstream token to use, when it differs from the connector's own. */
  upstreamToken?: string;
}

export interface ToolResultContent {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** True when the tool does not mutate anything or spend money. */
  readOnly: boolean;
  /** Estimated cost in USD for the given arguments, if the tool spends money. */
  estimate?: (args: Record<string, unknown>) => number;
  run: (args: Record<string, unknown>, ctx: ToolRunContext) => Promise<ToolResultContent>;
  /** True when the tool can take longer than a normal tool call. */
  longRunning?: boolean;
}

export interface ToolDeps {
  hf: HfClient | undefined;
  catalog: HfModelSpec[];
  quota: QuotaService;
  /** Media spend budget per day, in USD. */
  dailyUsdBudget: number;
  /** Poll interval while waiting for a generation, in ms. */
  pollIntervalMs?: number;
  now?: () => number;
}

/* ------------------------------------------------------------ helpers */

function text(value: string): Record<string, unknown> {
  return { type: "text", text: value };
}

/** The shared footer on every result that produced media. */
function mediaNotice(spec: HfModelSpec, costUsd: number, requestId: string): string {
  const provider = spec.provider !== "Higgsfield" ? ` Rendered by ${spec.provider}.` : "";
  const terms = spec.termsUrl ? ` ${spec.termsUrl} applies to this model.` : "";
  return (
    `AI-generated content (${spec.name}).${provider}` +
    ` Request ${requestId}. Estimated cost $${costUsd.toFixed(3)}.` +
    ` Generation consumes credits.${terms}`
  );
}

async function pollUntilTerminal(
  hf: HfClient,
  requestId: string,
  ctx: ToolRunContext,
  pollIntervalMs: number,
): Promise<{ status: string; urls: string[]; error?: unknown }> {
  const deadline = Date.now() + 15 * 60 * 1000;
  let elapsed = 0;
  const total = 900; // seconds, for the progress bar
  for (;;) {
    if (ctx.signal.aborted) throw new Error("Cancelled by the client.");
    const status = await hf.getStatus(requestId);
    if (isTerminal(status.status)) {
      return { status: status.status, urls: outputUrls(status), error: status.error };
    }
    ctx.progress(elapsed, total, `Generation ${status.status}...`);
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the generation to complete.");
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    elapsed += pollIntervalMs / 1000;
  }
}

/* -------------------------------------------------------------- tools */

export function buildTools(deps: ToolDeps): ToolDefinition[] {
  const pollIntervalMs = deps.pollIntervalMs ?? 5000;

  const listModels: ToolDefinition = {
    name: "list_generation_models",
    title: "List generation models",
    description:
      "List the video and image generation models available, with their provider, " +
      "duration limits and price per second. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Optional filter: video, image, audio, edit, upscale or lipsync.",
          enum: ["video", "image", "audio", "edit", "upscale", "lipsync"],
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    readOnly: true,
    async run(args) {
      const kind = typeof args.kind === "string" ? args.kind : undefined;
      const models = deps.catalog
        .filter((m) => !kind || m.kind === kind)
        .map((m) => ({
          endpoint_id: m.endpointId,
          name: m.name,
          kind: m.kind,
          provider: m.provider,
          price_per_unit_usd: m.unitPriceUsd,
          unit: m.unit,
          duration: m.duration ?? null,
          resolutions: m.resolutions ?? null,
          max_references: m.references ?? null,
          terms_url: m.termsUrl ?? null,
        }));
      return {
        content: [text(JSON.stringify({ models }, null, 2))],
        structuredContent: { models },
      };
    },
  };

  const getModel: ToolDefinition = {
    name: "get_generation_model",
    title: "Get generation model details",
    description: "Get the parameters, limits and price for one generation model. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_id: { type: "string", description: "The endpoint id, e.g. higgsfield/cinema-studio/4.0" },
      },
      required: ["endpoint_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    readOnly: true,
    async run(args) {
      const endpointId = String(args.endpoint_id ?? "");
      const spec = findHfModel(deps.catalog, endpointId);
      if (!spec) {
        return {
          content: [text(`Unknown model: ${endpointId}. Call list_generation_models for the catalog.`)],
          isError: true,
        };
      }
      return {
        content: [text(JSON.stringify(spec, null, 2))],
        structuredContent: spec as unknown as Record<string, unknown>,
      };
    },
  };

  const buildGenerationTool = (kind: "video" | "image"): ToolDefinition => {
    const isVideo = kind === "video";
    const name = isVideo ? "generate_video" : "generate_image";
    const title = isVideo ? "Generate video" : "Generate image";

    return {
      name,
      title,
      description: isVideo
        ? "Generate a video from a text prompt and optional reference media. The output is " +
          "AI-generated and the call consumes credits; the estimated cost is stated before " +
          "generation starts. Returns the video URL when the render completes."
        : "Generate an image from a text prompt and optional reference images. The output is " +
          "AI-generated and the call consumes credits; the estimated cost is stated before " +
          "generation starts. Returns the image URL when the render completes.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What to generate." },
          model: {
            type: "string",
            description: "Endpoint id of the model to use. Defaults to the recommended model.",
          },
          ...(isVideo
            ? {
                duration: { type: "integer", description: "Output duration in seconds." },
                resolution: { type: "string", description: "e.g. 720p or 1080p." },
                reference_videos: {
                  type: "array",
                  items: { type: "string" },
                  description: "Public URLs of reference videos.",
                },
                reference_audios: {
                  type: "array",
                  items: { type: "string" },
                  description: "Public URLs of reference audio.",
                },
              }
            : {}),
          reference_images: {
            type: "array",
            items: { type: "string" },
            description: "Public URLs of reference images.",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      readOnly: false,
      longRunning: isVideo,
      estimate(args) {
        const spec = resolveSpec(deps.catalog, args, kind);
        if (!spec) return 0;
        const units = isVideo
          ? Number(args.duration ?? spec.duration?.default ?? 5)
          : 1;
        return estimateCost(spec, units);
      },
      async run(args, ctx) {
        const spec = resolveSpec(deps.catalog, args, kind);
        if (!spec) {
          return {
            content: [text(`No ${kind} model is available. Call list_generation_models for the catalog.`)],
            isError: true,
          };
        }
        if (!deps.hf) {
          return {
            content: [text("No Higgsfield credential is configured; generation is unavailable.")],
            isError: true,
          };
        }

        const prompt = String(args.prompt ?? "").trim();
        if (!prompt) {
          return { content: [text("A prompt is required.")], isError: true };
        }

        // Small models routinely send "" for every optional field. Treat an
        // empty string as absent rather than passing it to the provider.
        const optionalString = (value: unknown): string | undefined => {
          if (typeof value !== "string") return undefined;
          const trimmed = value.trim();
          return trimmed === "" ? undefined : trimmed;
        };
        const optionalList = (value: unknown): string[] | undefined => {
          if (!Array.isArray(value)) return undefined;
          const items = value
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter((v) => v !== "");
          return items.length > 0 ? items : undefined;
        };

        const duration = isVideo
          ? Math.max(
              spec.duration?.min ?? 1,
              Math.min(
                spec.duration?.max ?? 30,
                Number(args.duration ?? spec.duration?.default ?? 5),
              ),
            )
          : undefined;
        const units = isVideo ? (duration as number) : 1;
        const cost = estimateCost(spec, units);

        // Hold budget before spending; settle against the real cost after.
        const decision = await deps.quota.admit({
          subject: ctx.subject,
          budget: { maxUsd: deps.dailyUsdBudget, window: "day" },
          estimatedUsd: cost,
        });
        if (!decision.allowed) {
          return { content: [text(decision.message)], isError: true };
        }
        const reservation = deps.quota.reservationFor(
          ctx.subject,
          { maxUsd: deps.dailyUsdBudget, window: "day" },
          decision.reservedUsd,
        );

        const input: Record<string, unknown> = { prompt };
        if (duration !== undefined) input.duration = duration;
        const resolution = optionalString(args.resolution);
        if (resolution) input.resolution = resolution;
        const imageUrls = optionalList(args.reference_images);
        if (imageUrls) input.image_urls = imageUrls;
        const videoUrls = optionalList(args.reference_videos);
        if (videoUrls) input.video_urls = videoUrls;
        const audioUrls = optionalList(args.reference_audios);
        if (audioUrls) input.audio_urls = audioUrls;

        try {
          const submitted = await deps.hf.submit(spec.endpointId, input, {
            idempotencyKey: ctx.idempotencyKey,
          });
          ctx.progress(1, undefined, `Submitted as ${submitted.request_id}.`);

          const result = await pollUntilTerminal(
            deps.hf,
            submitted.request_id,
            ctx,
            pollIntervalMs,
          );

          if (result.status !== "completed") {
            // A failed generation is not charged: release the hold.
            await deps.quota.release(reservation);
            return {
              content: [
                text(
                  `Generation ${result.status}. Request ${submitted.request_id}.` +
                    (result.error ? ` ${JSON.stringify(result.error)}` : ""),
                ),
              ],
              structuredContent: { request_id: submitted.request_id, status: result.status },
              isError: result.status === "failed",
            };
          }

          // Settle the hold against the actual cost.
          await deps.quota.settle(reservation, cost);

          const urls = result.urls;
          return {
            content: [
              text(
                `Generated ${spec.name} (${submitted.request_id}).\n` +
                  urls.map((u) => `- ${u}`).join("\n") +
                  `\n${mediaNotice(spec, cost, submitted.request_id)}`,
              ),
              ...urls.map((u) => ({
                type: "resource_link",
                uri: u,
                name: `${spec.name} output`,
                mimeType: isVideo ? "video/mp4" : "image/*",
              })),
            ],
            structuredContent: {
              request_id: submitted.request_id,
              model: spec.endpointId,
              status: result.status,
              urls,
              estimated_cost_usd: Number(cost.toFixed(4)),
              ai_generated: true,
            },
          };
        } catch (err) {
          await deps.quota.release(reservation);
          const message = err instanceof Error ? err.message : String(err);
          return { content: [text(`Generation failed: ${message}`)], isError: true };
        }
      },
    };
  };

  const getRequestStatus: ToolDefinition = {
    name: "get_request_status",
    title: "Get generation status",
    description:
      "Check the status of a generation started earlier. Read-only, and does not " +
      "consume credits.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The Higgsfield request id." },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    readOnly: true,
    async run(args) {
      if (!deps.hf) {
        return { content: [text("No Higgsfield credential is configured.")], isError: true };
      }
      const requestId = String(args.request_id ?? "");
      const status = await deps.hf.getStatus(requestId);
      return {
        content: [text(JSON.stringify(status, null, 2))],
        structuredContent: status as unknown as Record<string, unknown>,
      };
    },
  };

  const cancelRequest: ToolDefinition = {
    name: "cancel_generation",
    title: "Cancel a queued generation",
    description:
      "Cancel a generation that has not started rendering yet. A generation that is " +
      "already rendering cannot be cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The Higgsfield request id." },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    readOnly: false,
    async run(args) {
      if (!deps.hf) {
        return { content: [text("No Higgsfield credential is configured.")], isError: true };
      }
      const requestId = String(args.request_id ?? "");
      try {
        await deps.hf.cancel(requestId);
        return {
          content: [text(`Cancelled ${requestId}.`)],
          structuredContent: { request_id: requestId, status: "canceled" },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [text(`Could not cancel ${requestId}: ${message}`)], isError: true };
      }
    },
  };

  return [
    listModels,
    getModel,
    buildGenerationTool("video"),
    buildGenerationTool("image"),
    getRequestStatus,
    cancelRequest,
  ];
}

function resolveSpec(
  catalog: HfModelSpec[],
  args: Record<string, unknown>,
  kind: "video" | "image",
): HfModelSpec | undefined {
  const requested = typeof args.model === "string" ? args.model : undefined;
  if (requested) return findHfModel(catalog, requested);
  const candidates = catalog.filter((m) => m.kind === kind);
  // Prefer the cheapest capable model so an unspecified request is predictable.
  return candidates.sort((a, b) => a.unitPriceUsd - b.unitPriceUsd)[0];
}

/**
 * Tools that relay to an upstream generation MCP server.
 *
 * The upstream's own parameter shape is preserved, so a server that nests
 * parameters under `params` (Higgsfield does) works without translation.
 */
export function buildRelayTools(deps: {
  upstream: UpstreamConnector;
  /** Our tool name -> the upstream's tool name. */
  nameMap?: Record<string, string>;
  /** Only these upstream tools are exposed. */
  only?: string[];
  /**
   * Wrap the arguments in this key before sending them upstream.
   *
   * Higgsfield nests every model parameter under `params`
   * (`{params: {model, prompt, duration, ...}}`), while most MCP servers
   * take them flat.
   */
  paramWrapper?: string;
}): ToolDefinition[] {
  const nameMap = deps.nameMap ?? {};
  const only = deps.only;
  const wrap = (args: Record<string, unknown>): Record<string, unknown> =>
    deps.paramWrapper ? { [deps.paramWrapper]: args } : args;

  const make = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, unknown>,
  ): ToolDefinition => ({
    name,
    title,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    readOnly: false,
    longRunning: true,
    async run(args, ctx) {
      const upstreamName = nameMap[name] ?? name;
      try {
        const result = await deps.upstream.callTool(
          upstreamName,
          wrap(args),
          {
            ...(ctx.clientInfo ? { clientInfo: ctx.clientInfo } : {}),
            ...(ctx.upstreamToken ? { token: ctx.upstreamToken } : {}),
          },
        );
        return {
          content: result.content,
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (err) {
        return {
          content: [
            text(
              `The upstream generation server could not be reached: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            ),
          ],
          isError: true,
        };
      }
    },
  });

  const tools: ToolDefinition[] = [];

  const video = make(
    "generate_video",
    "Generate video",
    "Generate a video from a text prompt and optional reference media. The output is " +
      "AI-generated and consumes credits. Forwarded to the upstream generation server.",
    {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to generate." },
        model: { type: "string", description: "The upstream model id." },
        duration: { type: "integer", description: "Duration in seconds." },
        resolution: { type: "string", description: "e.g. 480p, 720p, 1080p." },
        aspect_ratio: { type: "string", description: "e.g. 16:9, 9:16, 21:9." },
        generate_audio: { type: "boolean", description: "Generate audio for the video." },
        count: { type: "integer", description: "Number of variants (1-4)." },
        medias: {
          type: "array",
          description:
            "Reference media. The upstream accepts roles: start_image, end_image, " +
            "image_references, video_references, audio_references.",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              url: { type: "string" },
            },
            required: ["role", "url"],
          },
        },
        get_cost: { type: "boolean", description: "Quote the cost without generating." },
        use_unlim: { type: "boolean", description: "Spend a free-trial unlimited allowance." },
        use_free_gens: { type: "boolean", description: "Spend a free generation." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  );
  tools.push(video);

  const image = make(
    "generate_image",
    "Generate image",
    "Generate an image from a text prompt and optional reference images. The output is " +
      "AI-generated and consumes credits. Forwarded to the upstream generation server.",
    {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to generate." },
        model: { type: "string", description: "The upstream model id." },
        aspect_ratio: { type: "string", description: "e.g. 1:1, 16:9, 9:16." },
        count: { type: "integer", description: "Number of variants (1-4)." },
        medias: {
          type: "array",
          description: "Reference images.",
          items: {
            type: "object",
            properties: { role: { type: "string" }, url: { type: "string" } },
            required: ["role", "url"],
          },
        },
        get_cost: { type: "boolean", description: "Quote the cost without generating." },
        use_unlim: { type: "boolean", description: "Spend a free-trial unlimited allowance." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  );
  tools.push(image);

  if (only) return tools.filter((t) => only.includes(t.name));
  return tools;
}

/** Convert the internal tool definition into the MCP wire shape. */
export function toMcpTool(tool: ToolDefinition): McpTool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: tool.annotations,
  };
}
