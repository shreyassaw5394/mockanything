import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/index.ts", index: "src/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
