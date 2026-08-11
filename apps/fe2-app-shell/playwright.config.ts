// Playwright E2E for the mail vertical slice. Runs the assembled shell against the
// backend-free DEMO transport (VITE_DEMO=1): auto-login + seeded mail, so a real
// browser can drive compose → send → Sent and inbox read-state with no gateway.
// Scoped to this app; kept minimal (chromium only). The vitest suite remains the
// primary regression; this proves the flow in a real browser + captures screenshots.
import { defineConfig, devices } from "@playwright/test";

// Default 5174 (distinct from the dev port 5173). Overridable via E2E_PORT so a
// single vertical slice can be driven on a dedicated port (e.g. driveshare on 5211).
const PORT = Number(process.env.E2E_PORT ?? 5174);
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
    env: { VITE_DEMO: "1" },
  },
});
