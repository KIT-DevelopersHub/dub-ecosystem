import { defineConfig } from "astro/config";

// FE8 public pages — static SSG (design §1). No adapter: pure static output so the
// build never depends on a running backend (test-point 1). Same origin for the
// gateway inquiry POST unless PUBLIC_GATEWAY_ORIGIN is set at build time.
export default defineConfig({
  site: "https://developershub.jp",
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory" },
  compressHTML: true,
});
