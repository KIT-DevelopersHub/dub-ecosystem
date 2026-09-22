/** @type {import('next').NextConfig} */
// lp-conference-next — static SSG rebuild of the public conference LP.
// `output: "export"` produces a pure static site in ./out with no server
// runtime, so it deploys as an assets-only Cloudflare Worker (see wrangler.toml)
// and never depends on a running backend. Images are pre-sized mockup cut-outs
// already, so next/image runs unoptimized (no build-time image server) while
// still emitting responsive width/height + lazy loading for good CLS.
const nextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  // Allow an alternate build dir (e.g. NEXT_DIST_DIR=.next-build) so a
  // production build can run without clobbering a concurrently running
  // `next dev`. Defaults to the standard .next — no behavior change in CI.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
