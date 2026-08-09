import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/css.ts", "src/dtcg.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
