// Playwright E2E for the FE4 gantt delete-undo feature. Runs the standalone dev harness
// (in-memory mock client, DemoApp) so a real browser can drive delete → Ctrl-Z → confirm
// dialog → restore with no gateway. The vitest suite is the primary regression; this
// proves the flow in a real browser + captures screenshots.
import { defineConfig, devices } from "@playwright/test";

const PORT = 5202; // distinct from the dev port + other apps' E2E ports to avoid clashes
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
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
