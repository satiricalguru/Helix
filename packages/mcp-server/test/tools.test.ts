import { describe, expect, it } from "vitest";
import { buildTools, type ToolDefinition } from "../src/tools.js";
import { DEFAULT_HF_CATALOG } from "@helix/config";
import { InMemoryQuotaStore, QuotaService } from "@helix/quota";
import type { HfClient } from "@helix/hf-client";

function tools(hf?: HfClient): ToolDefinition[] {
  return buildTools({
    hf,
    catalog: DEFAULT_HF_CATALOG,
    quota: new QuotaService(new InMemoryQuotaStore()),
    dailyUsdBudget: 10,
    pollIntervalMs: 1,
  });
}

function ctx() {
  return {
    subject: "tenant-1",
    progress: () => {},
    signal: new AbortController().signal,
    idempotencyKey: "idem-1",
  };
}

/** A Higgsfield client stub that records what it was asked to do. */
function stubHf(status: "completed" | "failed" = "completed") {
  const calls: Array<{ endpointId: string; input: Record<string, unknown> }> = [];
  const hf = {
    submit: async (endpointId: string, input: Record<string, unknown>) => {
      calls.push({ endpointId, input });
      return {
        status: "queued",
        request_id: "req-1",
        status_url: "https://api.higgsfield.ai/requests/req-1/status",
        cancel_url: "https://api.higgsfield.ai/requests/req-1/cancel",
      };
    },
    getStatus: async () => ({
      status,
      request_id: "req-1",
      video: { url: "https://cdn.example/out.mp4" },
    }),
    cancel: async () => {},
  } as unknown as HfClient;
  return { hf, calls };
}

describe("generate_video — argument handling", () => {
  it("submits the prompt and duration", async () => {
    const { hf, calls } = stubHf();
    const tool = tools(hf).find((t) => t.name === "generate_video")!;
    const result = await tool.run({ prompt: "a lighthouse", duration: 8 }, ctx());
    expect(result.isError).toBeFalsy();
    expect(calls[0]!.input).toMatchObject({ prompt: "a lighthouse", duration: 8 });
  });

  it("treats empty strings as absent", async () => {
    const { hf, calls } = stubHf();
    const tool = tools(hf).find((t) => t.name === "generate_video")!;
    await tool.run(
      {
        prompt: "a lighthouse",
        resolution: "",
        model: "",
        reference_images: [],
        reference_videos: [],
      },
      ctx(),
    );
    const input = calls[0]!.input;
    expect(input.resolution).toBeUndefined();
    expect(input.image_urls).toBeUndefined();
    expect(input.video_urls).toBeUndefined();
  });

  it("drops blank entries from reference lists", async () => {
    const { hf, calls } = stubHf();
    const tool = tools(hf).find((t) => t.name === "generate_video")!;
    await tool.run({ prompt: "x", reference_images: ["  ", "https://cdn/a.png", ""] }, ctx());
    expect(calls[0]!.input.image_urls).toEqual(["https://cdn/a.png"]);
  });

  it("clamps the duration to the model's range", async () => {
    const { hf, calls } = stubHf();
    const tool = tools(hf).find((t) => t.name === "generate_video")!;
    const spec = DEFAULT_HF_CATALOG.find((m) => m.kind === "video")!;
    await tool.run({ prompt: "x", duration: 9999 }, ctx());
    expect(calls[0]!.input.duration).toBe(spec.duration!.max);
  });

  it("requires a prompt", async () => {
    const { hf } = stubHf();
    const tool = tools(hf).find((t) => t.name === "generate_video")!;
    const result = await tool.run({ prompt: "   " }, ctx());
    expect(result.isError).toBe(true);
    expect(String(result.content[0]!.text)).toContain("prompt is required");
  });

  it("reports a missing credential as a tool error", async () => {
    const tool = tools(undefined).find((t) => t.name === "generate_video")!;
    const result = await tool.run({ prompt: "x" }, ctx());
    expect(result.isError).toBe(true);
    expect(String(result.content[0]!.text)).toContain("credential");
  });
});

describe("generate_video — results", () => {
  it("returns the output url and marks the result as AI-generated", async () => {
    const { hf } = stubHf();
    const tool = tools(hf).find((t) => t.name === "generate_video")!;
    const result = await tool.run({ prompt: "x", duration: 5 }, ctx());
    const structured = result.structuredContent as {
      urls: string[];
      ai_generated: boolean;
      estimated_cost_usd: number;
    };
    expect(structured.urls).toEqual(["https://cdn.example/out.mp4"]);
    expect(structured.ai_generated).toBe(true);
    expect(structured.estimated_cost_usd).toBeGreaterThan(0);
  });

  it("states in the text that the output is AI-generated and consumes credits", async () => {
    const { hf } = stubHf();
    const tool = tools(hf).find((t) => t.name === "generate_video")!;
    const result = await tool.run({ prompt: "x", duration: 5 }, ctx());
    const text = String(result.content[0]!.text);
    expect(text).toMatch(/AI-generated/);
    expect(text).toMatch(/consumes credits/);
  });

  it("surfaces a failed generation as a tool error", async () => {
    const { hf } = stubHf("failed");
    const tool = tools(hf).find((t) => t.name === "generate_video")!;
    const result = await tool.run({ prompt: "x", duration: 5 }, ctx());
    expect(result.isError).toBe(true);
    expect(String(result.content[0]!.text)).toContain("failed");
  });

  it("releases the budget reservation when the generation fails", async () => {
    const { hf } = stubHf("failed");
    const quota = new QuotaService(new InMemoryQuotaStore());
    const list = buildTools({
      hf,
      catalog: DEFAULT_HF_CATALOG,
      quota,
      dailyUsdBudget: 10,
      pollIntervalMs: 1,
    });
    const tool = list.find((t) => t.name === "generate_video")!;
    await tool.run({ prompt: "x", duration: 5 }, ctx());
    expect(await quota.spent("tenant-1", "day")).toBe(0);
  });
});

describe("cost estimation", () => {
  it("scales with the duration", () => {
    const tool = tools().find((t) => t.name === "generate_video")!;
    const five = tool.estimate?.({ duration: 5 })!;
    const ten = tool.estimate?.({ duration: 10 })!;
    expect(ten).toBeCloseTo(five * 2, 6);
  });

  it("charges per image for image models", () => {
    const tool = tools().find((t) => t.name === "generate_image")!;
    expect(tool.estimate?.({})).toBeGreaterThan(0);
  });
});

describe("read-only tools", () => {
  it("list_generation_models returns the catalog", async () => {
    const tool = tools().find((t) => t.name === "list_generation_models")!;
    const result = await tool.run({}, ctx());
    const structured = result.structuredContent as { models: unknown[] };
    expect(structured.models.length).toBeGreaterThan(0);
  });

  it("list_generation_models filters by kind", async () => {
    const tool = tools().find((t) => t.name === "list_generation_models")!;
    const result = await tool.run({ kind: "image" }, ctx());
    const structured = result.structuredContent as { models: Array<{ kind: string }> };
    expect(structured.models.every((m) => m.kind === "image")).toBe(true);
  });

  it("get_generation_model reports an unknown model as an error", async () => {
    const tool = tools().find((t) => t.name === "get_generation_model")!;
    const result = await tool.run({ endpoint_id: "nope" }, ctx());
    expect(result.isError).toBe(true);
  });
});
