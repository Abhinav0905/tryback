import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .mts so Vite loads it as native ESM (the package has no "type": "module").
export default defineConfig({
  resolve: {
    alias: { "@": path.dirname(fileURLToPath(import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { TRYBACK_DATA_DIR: ".data-test" },
  },
});
