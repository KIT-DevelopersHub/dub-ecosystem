// Playwright E2E for FE3's shared section layout (D&D). Runs the standalone dev
// harness (main.tsx: mock EventApi, fully-permissioned session) against a real
// browser — proves what a jsdom unit test cannot: pointer drag-and-drop actually
// reorders sections, and the reorder + hide/show survive a reload (the mock's
// localStorage stand-in for the real event-service's shared, version-locked row).
// Scoped to this app; kept minimal (chromium only), mirroring fe2-app-shell's
// e2e/playwright.config.ts.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5183);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.output",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // The layout 編集モード's jiggle animation (like FE2's Home 編集モード) honours
    // prefers-reduced-motion (drops to `animation: none`) — force it here so
    // Playwright's actionability "element is stable" check isn't fighting a
    // continuous CSS rotation on every click inside an edited row.
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
