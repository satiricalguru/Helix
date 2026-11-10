/**
 * Static catalogs: the models Helix serves and the Higgsfield endpoints it can
 * drive.
 *
 * Both are snapshots. Higgsfield can change its catalog and pricing at any
 * time, so these are refreshed by a job and versioned, not trusted blindly.
 */

import type { HfModelSpec, ModelSpec } from "@helix/contracts";

/* ------------------------------------------------------------- models */

export interface ModelDeployment {
  id: string;
  provider: "local";
  /** The upstream model identifier, e.g. "qwen3:32b". */
  model: string;
  /** Base URL of the OpenAI-compatible server. */
  baseUrl: string;
  /** Lower = preferred. */
  priority: number;
  /** Relative share of traffic when several deployments are healthy. */
  weight: number;
  /** Real context window of the upstream model, in tokens. */
  maxContextTokens: number;
  /**
   * The context window to request from the upstream.
   *
   * Ollama defaults to 4096 tokens whatever the model's capability says,
   * which a handful of tool schemas will blow through.
   */
  numCtx?: number;
  /** Whether the upstream exposes reasoning tokens. */
  supportsThinking: boolean;
  /** Whether the upstream accepts OpenAI-style reasoning_effort. */
  supportsReasoningEffort: boolean;
  /** Whether the upstream accepts response_format json_schema. */
  supportsJsonSchema: boolean;
}

export interface ModelGroup {
  /** What clients send, e.g. "helix-fable-5-2". */
  advertisedId: string;
  displayName: string;
  line: "haiku" | "sonnet" | "opus" | "fable" | "mythos";
  maxInputTokens: number;
  maxOutputTokens: number;
  defaultEffort: "low" | "medium" | "high" | "xhigh" | "max";
  allowedEfforts: readonly ("low" | "medium" | "high" | "xhigh" | "max")[];
  /** Shown to clients so nobody is misled about provenance. */
  disclosure: string;
  deployments: ModelDeployment[];
}

/** The behaviour spec the validator uses. Derived from the group. */
export function toModelSpec(group: ModelGroup): ModelSpec {
  return {
    id: group.advertisedId,
    line: group.line,
    maxInputTokens: group.maxInputTokens,
    maxOutputTokens: group.maxOutputTokens,
    defaultEffort: group.defaultEffort,
    allowedEfforts: group.allowedEfforts,
    thinkingTypes: ["adaptive"],
    toolChoiceTypes: ["auto", "none"],
    allowsSamplingParams: false,
    minCacheableTokens: 512,
  };
}

const LOCAL_BASE_URL = process.env.HELIX_LOCAL_BASE_URL ?? "http://127.0.0.1:11434/v1";
const LOCAL_MODEL = process.env.HELIX_LOCAL_MODEL ?? "qwen3:32b";

export const DEFAULT_MODEL_GROUPS: ModelGroup[] = [
  {
    advertisedId: process.env.HELIX_ADVERTISE_MODEL_ID ?? "helix-fable-5-2",
    displayName: "Helix Fable 5.2 (local)",
    line: "fable",
    maxInputTokens: 131_072,
    maxOutputTokens: 32_768,
    defaultEffort: "high",
    allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
    disclosure:
      "This model is served by a local model server running on your own hardware. " +
      "It is not Anthropic's Claude Fable 5.2 and no Anthropic service is involved.",
    deployments: [
      {
        id: "local-default",
        provider: "local",
        model: LOCAL_MODEL,
        baseUrl: LOCAL_BASE_URL,
        priority: 1,
        weight: 100,
        maxContextTokens: 131_072,
        numCtx: Number(process.env.HELIX_LOCAL_NUM_CTX ?? 32768),
        supportsThinking: true,
        supportsReasoningEffort: true,
        supportsJsonSchema: true,
      },
    ],
  },
];

/* --------------------------------------------------- higgsfield catalog */

/**
 * A snapshot of Higgsfield endpoints.
 *
 * Prices are USD per unit as published on open.higgsfield.ai (Nov 2026) and
 * are indicative only — always show an estimate, never a guarantee.
 */
export const DEFAULT_HF_CATALOG: HfModelSpec[] = [
  {
    endpointId: "higgsfield/cinema-studio/4.0",
    name: "Cinema Studio 4.0",
    kind: "video",
    provider: "Higgsfield",
    family: "higgsfield",
    unitPriceUsd: 0.07,
    unit: "second",
    duration: { min: 4, max: 30, default: 5 },
    resolutions: ["480p", "720p"],
    references: { images: 30, videos: 10, audios: 10 },
    description: "Cinematic text-to-video and reference-to-video with camera and lens controls.",
  },
  {
    endpointId: "higgsfield/seedance/2.5",
    name: "Seedance 2.5",
    kind: "video",
    provider: "ByteDance",
    family: "seedance",
    unitPriceUsd: 0.144,
    unit: "second",
    duration: { min: 3, max: 30, default: 5 },
    resolutions: ["720p", "1080p"],
    references: { images: 50, videos: 10, audios: 10 },
    termsUrl: "https://seed.bytedance.com/en/terms",
    description: "Multi-shot video generation with native audio, up to 30 seconds.",
  },
  {
    endpointId: "higgsfield/kling/4.0",
    name: "Kling 4.0",
    kind: "video",
    provider: "Kuaishou",
    family: "kling",
    unitPriceUsd: 0.066,
    unit: "second",
    duration: { min: 3, max: 30, default: 5 },
    resolutions: ["720p", "1080p"],
    references: { images: 15, videos: 5, audios: 5 },
    description: "Video generation from text, images and video references with keyframes.",
  },
  {
    endpointId: "higgsfield/kling/4.0/flash",
    name: "Kling 4.0 Flash",
    kind: "video",
    provider: "Kuaishou",
    family: "kling",
    unitPriceUsd: 0.047,
    unit: "second",
    duration: { min: 3, max: 20, default: 5 },
    resolutions: ["720p"],
    description: "Faster, cheaper 720p Kling generation.",
  },
  {
    endpointId: "higgsfield/veo/3.1",
    name: "Google Veo 3.1",
    kind: "video",
    provider: "Google",
    family: "veo",
    unitPriceUsd: 0.2,
    unit: "second",
    duration: { min: 4, max: 8, default: 4 },
    resolutions: ["720p", "1080p"],
    description: "Veo 3.1 with native audio. One of the most expensive models in the catalog.",
  },
  {
    endpointId: "higgsfield/wan/3.0",
    name: "WAN 3.0",
    kind: "video",
    provider: "Alibaba",
    family: "wan",
    unitPriceUsd: 0.025,
    unit: "second",
    duration: { min: 3, max: 30, default: 5 },
    resolutions: ["480p", "720p", "1080p"],
    description: "Cost-efficient video generation across resolutions.",
  },
  {
    endpointId: "higgsfield/wan/3.0/prime",
    name: "WAN 3.0 Prime",
    kind: "video",
    provider: "Alibaba",
    family: "wan",
    unitPriceUsd: 0.041,
    unit: "second",
    duration: { min: 3, max: 30, default: 5 },
    resolutions: ["480p", "720p", "1080p"],
    description: "Higher quality tier of WAN 3.0.",
  },
  {
    endpointId: "higgsfield/genjutsu/motion-transfer/v1.0",
    name: "Genjutsu Motion Transfer",
    kind: "edit",
    provider: "Higgsfield",
    family: "higgsfield",
    unitPriceUsd: 0.159,
    unit: "second",
    duration: { min: 1, max: 15, default: 5 },
    references: { images: 1, videos: 1 },
    description: "Transfer motion from a reference video onto a subject (first 15 seconds).",
  },
  {
    endpointId: "higgsfield/genjutsu/object-swap/v1.0",
    name: "Genjutsu Object Swap",
    kind: "edit",
    provider: "Higgsfield",
    family: "higgsfield",
    unitPriceUsd: 0.159,
    unit: "second",
    duration: { min: 1, max: 15, default: 5 },
    references: { images: 1, videos: 1 },
    description: "Swap a character, location or style into a reference video.",
  },
  {
    endpointId: "higgsfield/soul/v2/standard",
    name: "Soul 2.0",
    kind: "image",
    provider: "Higgsfield",
    family: "higgsfield",
    unitPriceUsd: 0.002,
    unit: "image",
    description: "Photorealistic image generation for fashion and editorial.",
  },
  {
    endpointId: "higgsfield/nano-banana/pro",
    name: "Nano Banana Pro",
    kind: "image",
    provider: "Google",
    family: "nano-banana",
    unitPriceUsd: 0.02,
    unit: "image",
    references: { images: 14 },
    description: "Flagship Gemini image model with strong prompt adherence.",
  },
  {
    endpointId: "higgsfield/flux/2/pro",
    name: "FLUX 2 Pro",
    kind: "image",
    provider: "Black Forest Labs",
    family: "flux",
    unitPriceUsd: 0.01,
    unit: "image",
    description: "Structured visual control for still images.",
    termsUrl: "https://bfl.ai/terms",
  },
  {
    endpointId: "higgsfield/seedream/5/pro",
    name: "Seedream 5.0 Pro",
    kind: "image",
    provider: "ByteDance",
    family: "seedream",
    unitPriceUsd: 0.01,
    unit: "image",
    references: { images: 10 },
    description: "Multi-reference image generation.",
  },
  {
    endpointId: "higgsfield/gpt-image/2.6",
    name: "GPT Image 2.6",
    kind: "image",
    provider: "OpenAI",
    family: "gpt-image",
    unitPriceUsd: 0.02,
    unit: "image",
    description: "Image generation with native GIF and SVG output.",
  },
];

/** Find a catalog entry by endpoint id. */
export function findHfModel(catalog: HfModelSpec[], endpointId: string): HfModelSpec | undefined {
  return catalog.find((m) => m.endpointId === endpointId);
}

/** Estimate the USD cost of a generation from the catalog. */
export function estimateCost(spec: HfModelSpec, units: number): number {
  return Math.max(0, units) * spec.unitPriceUsd;
}

/** Find a model group by its advertised id. */
export function findModelGroup(
  groups: ModelGroup[],
  advertisedId: string,
): ModelGroup | undefined {
  return groups.find((g) => g.advertisedId === advertisedId);
}
