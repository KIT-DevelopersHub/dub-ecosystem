// Visual-regression config for the @dub/ui Storybook catalog.
//
// WHY Storybook: it already renders every @dub/ui component (Button…AppShell,
// Sidebar, Layout, DataTable, Modal, Timeline, MessageList …) deterministically
// with a light/dark theme toolbar. Per the FE convention we target the built
// static catalog (storybook-static/) — no backend, no data, fully hermetic.
//
// WHY $0 / self-hosted: uses Playwright's built-in `toHaveScreenshot()` pixel
// diff. Baselines are committed to the repo (git), diffs surface as CI artifacts.
// No SaaS (Chromatic/Percy) — nothing paid.
//
// DETERMINISM: @dub/tokens uses system-ui fonts, which rasterize differently per
// OS. Baselines therefore carry a `{platform}` suffix (see snapshotPathTemplate)
// so macOS-generated and Linux/Docker-generated PNGs coexist. CI runs inside the
// pinned Playwright Docker image (fixed OS + fonts) so its Linux baselines are
// stable run-to-run. `maxDiffPixelRatio` absorbs sub-pixel anti-alias noise.
import { defineConfig, devices } from "@playwright/test";

const SB_PORT = Number(process.env.SB_PORT ?? 6007);
const BASE_URL = `http://localhost:${SB_PORT}`;

// Desktop + mobile(375, Android-ish) — the mobile viewport is what catches the
// responsive/overflow regressions we care about.
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 812 };

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "./.output",
  snapshotDir: "./__screenshots__",
  // <file>/<project>/<story-id>-<theme>-<platform>.png. {projectName} keeps the
  // desktop(1280) and mobile(375) shots in separate dirs; {platform} keeps
  // macOS(local) and Linux(CI/Docker) baselines side by side without clobbering.
  snapshotPathTemplate:
    "{snapshotDir}/{testFileName}/{projectName}/{arg}-{platform}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Rendering is deterministic run-to-run within one OS (and CI pins the
      // Playwright Docker image), so tolerance only needs to absorb the odd
      // 1-px anti-alias flicker — NOT mask real changes. A small absolute
      // `maxDiffPixels` catches localized breakage (e.g. a border-radius /
      // spacing shift on one component) that a percentage ratio would dilute
      // against the story's large whitespace surface.
      maxDiffPixels: 60,
      threshold: 0.2,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  reporter: [["list"], ["html", { outputFolder: ".report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    // Freeze time-ish: deterministic locale/timezone so any date rendering is stable.
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    colorScheme: "light",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: DESKTOP },
    },
    {
      name: "mobile",
      // Pixel-5-ish width; Android is the breakage source we regression-guard.
      use: { ...devices["Pixel 5"], viewport: MOBILE },
    },
  ],
  webServer: {
    // webServer cwd defaults to the config dir (apps/fe1-design-system/visual);
    // serve.mjs resolves storybook-static relative to its own __dirname.
    command: "node serve.mjs",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { SB_PORT: String(SB_PORT) },
  },
});
