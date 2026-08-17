// Playwright E2E for the FE7 roster inline-role feature. Runs the standalone dev
// harness (in-memory mock client, auto-login as an admin) so a real browser can drive
// the ロール column + inline grant/revoke with no gateway. The vitest suite remains the
// primary regression; this proves the flow in a real browser + captures screenshots.
import { defineConfig, devices } from "@playwright/test";

const PORT = 5201; // distinct from the dev port (5177) to avoid clashes
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
