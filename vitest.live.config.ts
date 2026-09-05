import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
  },
});
