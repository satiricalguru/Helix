import { describe, expect, it } from "vitest";
import { conversationDigest, ThinkingSigner } from "../src/signature.js";
import type { MessagesRequest } from "@helix/contracts";

describe("ThinkingSigner", () => {
  const signer = new ThinkingSigner("secret");

  it("mints a verifiable signature", () => {
    const sig = signer.mint("digest", 0, "reasoning");
    expect(signer.verify(sig, "digest", 0, "reasoning")).toBe(true);
  });

  it("rejects a signature bound to a different conversation", () => {
    const sig = signer.mint("digest-a", 0, "reasoning");
    expect(signer.verify(sig, "digest-b", 0, "reasoning")).toBe(false);
  });

  it("rejects a signature bound to a different block index", () => {
    const sig = signer.mint("digest", 0, "reasoning");
    expect(signer.verify(sig, "digest", 1, "reasoning")).toBe(false);
  });

  it("rejects a signature over tampered text", () => {
    const sig = signer.mint("digest", 0, "reasoning");
    expect(signer.verify(sig, "digest", 0, "tampered")).toBe(false);
  });

  it("rejects a signature minted by another key", () => {
    const other = new ThinkingSigner("different-secret");
    const sig = other.mint("digest", 0, "reasoning");
    expect(signer.verify(sig, "digest", 0, "reasoning")).toBe(false);
  });

  it("rejects a signature that is not ours", () => {
    expect(signer.verify("not-a-signature", "digest", 0, "reasoning")).toBe(false);
    expect(signer.verify("", "digest", 0, "reasoning")).toBe(false);
  });

  it("marks its signatures so they cannot be confused with Anthropic's", () => {
    expect(signer.mint("digest", 0, "x")).toMatch(/^hx1\./);
  });

  it("requires a non-empty secret", () => {
    expect(() => new ThinkingSigner("")).toThrow(/non-empty/);
  });

  it("accepts a Buffer secret", () => {
    const s = new ThinkingSigner(Buffer.from("bytes-secret"));
    expect(s.verify(s.mint("d", 0, "t"), "d", 0, "t")).toBe(true);
  });
});

describe("conversationDigest", () => {
  const base: MessagesRequest = {
    model: "helix-fable-5-2",
    max_tokens: 100,
    messages: [{ role: "user", content: "hello" }],
  } as MessagesRequest;

  it("is stable for identical requests", () => {
    expect(conversationDigest(base)).toBe(conversationDigest({ ...base }));
  });

  it("changes when the messages change", () => {
    const other = { ...base, messages: [{ role: "user", content: "different" }] };
    expect(conversationDigest(base)).not.toBe(conversationDigest(other));
  });

  it("changes when the system prompt changes", () => {
    const other = { ...base, system: "be terse" };
    expect(conversationDigest(base)).not.toBe(conversationDigest(other));
  });

  it("changes when the tools change", () => {
    const other = {
      ...base,
      tools: [{ name: "t", input_schema: { type: "object" } }],
    };
    expect(conversationDigest(base)).not.toBe(conversationDigest(other));
  });

  it("changes when the model changes", () => {
    expect(conversationDigest(base)).not.toBe(conversationDigest({ ...base, model: "other" }));
  });
});
