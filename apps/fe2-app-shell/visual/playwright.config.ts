// App-SCREEN visual regression for the fe2 admin SPA (Playwright toHaveScreenshot).
//
// Complements the component-level suite in apps/fe1-design-system/visual: that one
// diffs isolated @dub/ui stories, this one diffs whole assembled screens (shell +
// feature apps) so layout/composition regressions that no single story shows get
// caught. Backend-free: the bundle is built with VITE_DEMO=1 (demo-seed transport,
// auto-login + seeded data) and served by `vite preview`. $0, no SaaS.
//
// Determinism: fixed viewport, ja-JP/Asia/Tokyo, light scheme, reduced motion, a
// frozen clock (see screens.spec.ts), animations disabled. Baselines carry a
// {platform} suffix — CI diffs the *-linux.png set generated in the SAME pinned
// Playwright image as the fe1 suite (mcr.microsoft.com/playwright:v1.62.1-jammy).
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.VISUAL_PORT ?? 5419);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "./.output",
  snapshotDir: "./__screenshots__",
  snapshotPathTemplate: "{snapshotDir}/{testFileName}/{projectName}/{arg}-{platform}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // Whole screens are big (1440x900); a small absolute budget absorbs AA
      // flicker while still flagging a shifted card / spacing change.
      maxDiffPixels: 150,
      threshold: 0.2,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: ".report", open: "never" }],
    // Consumed by the CI step that builds the PR comment.
    ["json", { outputFile: "results.json" }],
  ],
  use: {
    baseURL: BASE_URL,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    colorScheme: "light",
    reducedMotion: "reduce",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    // Only screens tagged @mobile run here (cheap subset).
    { name: "mobile", grep: /@mobile/, use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    // Serves the prebuilt VITE_DEMO=1 dist/ (build first: `pnpm --filter @dub/fe2-app-shell visual:build`).
    command: `pnpm exec vite preview --port ${PORT} --strictPort`,
    cwd: "..",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
