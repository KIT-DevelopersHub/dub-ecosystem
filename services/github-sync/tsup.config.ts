import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  external: [
    "@dub/auth-client",
    "@dub/db",
    "@dub/errors",
    "@dub/events",
    "@dub/http",
    "@dub/observability",
    "@dub/types",
    "hono",
    "cloudflare:workers",
  ],
});
