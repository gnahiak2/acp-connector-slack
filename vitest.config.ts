import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development", "node", "import"],
  },
  test: {
    environment: "node",
    env: { NODE_ENV: "development" },
    include: [
      "tests/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
      "apps/server/tests/**/*.test.ts",
      "apps/web/src/**/*.test.tsx",
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts", "apps/server/src/**/*.ts"],
    },
  },
});
