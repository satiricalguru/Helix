import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhook, WebhookDeduplicator } from "../src/webhook.js";
import { Semaphore } from "../src/pool.js";

const secret = "whsec_test";

function sign(id: string, timestamp: string, body: string, key = secret): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

describe("verifyWebhook", () => {
  const id = "evt_1";
  const timestamp = "1762752000";
  const body = JSON.stringify({ request_id: "r", status: "completed" });

  it("accepts a correctly signed delivery", () => {
    const result = verifyWebhook(
      { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": sign(id, timestamp, body) },
      body,
      { secret, now: () => Number(timestamp) * 1000 },
    );
    expect(result).toEqual({ ok: true, webhookId: id });
  });

  it("rejects a tampered body", () => {
    const result = verifyWebhook(
      { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": sign(id, timestamp, body) },
      JSON.stringify({ request_id: "r", status: "failed" }),
      { secret, now: () => Number(timestamp) * 1000 },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const result = verifyWebhook(
      {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": sign(id, timestamp, body, "other"),
      },
      body,
      { secret, now: () => Number(timestamp) * 1000 },
    );
    expect(result.ok).toBe(false);
  });

  it("accepts any matching signature when several are offered", () => {
    const good = sign(id, timestamp, body);
    const bad = sign(id, timestamp, body, "other");
    const result = verifyWebhook(
      {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${"A".repeat(43)} v0,xyz ${good}`,
      },
      body,
      { secret, now: () => Number(timestamp) * 1000 },
    );
    expect(result.ok).toBe(true);
    void bad;
  });

  it("rejects a delivery with no v1 signature", () => {
    const result = verifyWebhook(
      { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": "v0,abc" },
      body,
      { secret, now: () => Number(timestamp) * 1000 },
    );
    expect(result).toEqual({ ok: false, reason: "no v1 signature present" });
  });

  it("rejects a missing webhook-id", () => {
    const result = verifyWebhook(
      { "webhook-timestamp": timestamp, "webhook-signature": "v1,x" },
      body,
      { secret, now: () => Number(timestamp) * 1000 },
    );
    expect(result).toEqual({ ok: false, reason: "missing webhook-id" });
  });

  it("rejects a delivery outside the tolerance window", () => {
    const result = verifyWebhook(
      {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": sign(id, timestamp, body),
      },
      body,
      { secret, toleranceSeconds: 60, now: () => (Number(timestamp) + 600) * 1000 },
    );
    expect(result).toEqual({ ok: false, reason: "webhook timestamp outside tolerance" });
  });

  it("rejects a non-numeric timestamp", () => {
    const result = verifyWebhook(
      { "webhook-id": id, "webhook-timestamp": "not-a-number", "webhook-signature": "v1,x" },
      body,
      { secret },
    );
    expect(result).toEqual({ ok: false, reason: "invalid webhook-timestamp" });
  });

  it("supports the legacy shared-secret header", () => {
    const result = verifyWebhook(
      { "webhook-id": id, "webhook-timestamp": timestamp, "x-webhook-secret-key": secret },
      body,
      { secret, now: () => Number(timestamp) * 1000 },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong legacy secret", () => {
    const result = verifyWebhook(
      { "webhook-id": id, "webhook-timestamp": timestamp, "x-webhook-secret-key": "nope" },
      body,
      { secret, now: () => Number(timestamp) * 1000 },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a delivery with no signature at all", () => {
    const result = verifyWebhook(
      { "webhook-id": id, "webhook-timestamp": timestamp },
      body,
      { secret, now: () => Number(timestamp) * 1000 },
    );
    expect(result).toEqual({ ok: false, reason: "missing webhook-signature" });
  });
});

describe("WebhookDeduplicator", () => {
  it("accepts an id once", () => {
    const d = new WebhookDeduplicator();
    expect(d.markOnce("evt_1")).toBe(true);
    expect(d.markOnce("evt_1")).toBe(false);
  });

  it("accepts distinct ids", () => {
    const d = new WebhookDeduplicator();
    expect(d.markOnce("evt_1")).toBe(true);
    expect(d.markOnce("evt_2")).toBe(true);
    expect(d.size).toBe(2);
  });

  it("forgets ids after the ttl", () => {
    const d = new WebhookDeduplicator({ ttlMs: 1000 });
    expect(d.markOnce("evt_1", 0)).toBe(true);
    expect(d.markOnce("evt_1", 500)).toBe(false);
    expect(d.markOnce("evt_1", 2000)).toBe(true);
  });

  it("bounds its size", () => {
    const d = new WebhookDeduplicator({ max: 10 });
    for (let i = 0; i < 50; i++) d.markOnce(`evt_${i}`, i);
    expect(d.size).toBeLessThanOrEqual(10);
  });
});

describe("Semaphore", () => {
  it("limits concurrency to the capacity", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      release();
    };
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it("releases the slot when the task throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sem.inUse).toBe(0);
  });

  it("ignores a double release", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.inUse).toBe(0);
  });
});
