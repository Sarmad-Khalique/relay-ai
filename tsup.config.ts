import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli-main.ts",
    index: "src/index.ts",
    "adapter-contract": "src/adapter-contract.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  external: ["better-sqlite3"],
});
