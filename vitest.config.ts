import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // types.ts is type-only; extension.ts is thin factory wiring.
      exclude: ["src/types.ts", "src/extension.ts"],
    },
  },
});
