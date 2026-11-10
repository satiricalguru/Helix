import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonFileUserStore, hashPassword, verifyPassword } from "../src/oauth.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "helix-users-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("JsonFileUserStore", () => {
  it("starts empty when the file does not exist", async () => {
    await withTempDir(async (dir) => {
      const store = await JsonFileUserStore.open(path.join(dir, "users.json"));
      expect(await store.findByEmail("a@example.com")).toBeUndefined();
    });
  });

  it("persists an account across reloads", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "users.json");
      const store = await JsonFileUserStore.open(file);
      await store.create("a@example.com", hashPassword("pw"));

      const reloaded = await JsonFileUserStore.open(file);
      const found = await reloaded.findByEmail("a@example.com");
      expect(found).toBeDefined();
      expect(found?.email).toBe("a@example.com");
      expect(verifyPassword("pw", found!.passwordHash)).toBe(true);
    });
  });

  it("writes only hashes, never plaintext", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "users.json");
      const store = await JsonFileUserStore.open(file);
      await store.create("a@example.com", hashPassword("super-secret"));
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain("super-secret");
      expect(raw).toContain("pbkdf2-sha256");
    });
  });

  it("looks accounts up case-insensitively", async () => {
    await withTempDir(async (dir) => {
      const store = await JsonFileUserStore.open(path.join(dir, "users.json"));
      await store.create("Alice@Example.com", hashPassword("pw"));
      expect(await store.findByEmail("alice@example.com")).toBeDefined();
    });
  });

  it("survives a corrupt file by starting empty", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "users.json");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(file, "{not json");
      const store = await JsonFileUserStore.open(file);
      expect(await store.findByEmail("a@example.com")).toBeUndefined();
    });
  });
});

describe("password hashes", () => {
  it("records the algorithm and iteration count", () => {
    const stored = hashPassword("pw");
    expect(stored.startsWith("pbkdf2-sha256$100000$")).toBe(true);
  });

  it("rejects a hash from an unknown algorithm", () => {
    expect(verifyPassword("pw", "scrypt$1$abc$def")).toBe(false);
  });

  it("rejects a hash with a zero iteration count", () => {
    expect(verifyPassword("pw", "pbkdf2-sha256$0$abc$def")).toBe(false);
  });
});
