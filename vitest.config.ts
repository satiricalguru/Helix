import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.resolve(root, "packages", name, "src");

export default defineConfig({
  resolve: {
    alias: {
      "@helix/contracts": path.join(pkg("contracts"), "index.ts"),
      "@helix/config": path.join(pkg("config"), "index.ts"),
      "@helix/hf-client": path.join(pkg("hf-client"), "index.ts"),
      "@helix/quota": path.join(pkg("quota"), "index.ts"),
      "@helix/local-adapter": path.join(pkg("local-adapter"), "index.ts"),
      "@helix/gateway": path.join(pkg("gateway"), "index.ts"),
      "@helix/mcp-server": path.join(pkg("mcp-server"), "index.ts"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "test/**/*.test.ts"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/index.ts", "**/main.ts", "**/*.d.ts", "**/types.ts"],
    },
    // The SSE / streaming tests are timing-sensitive; give them room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
