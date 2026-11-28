// チケット購入 → 決済（Stripe テストモード）→ 発券 → 当日受付 をブラウザで通す E2E（#897）。
// 普段の e2e（VITE_DEMO の demo transport）とは別に、本物の lp-tickets + 公開 LP Worker をつないだ
// スタック（packages/e2e-smoke/src/ticket-server.ts）を立て、fe2 をそこへ向けて起動する。
// 外部への通信は無い（Stripe は偽物・テストキーのみ）。CI は .github/workflows/ticket-flow-e2e.yml。
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5215);
const STACK_PORT = Number(process.env.TICKET_E2E_STACK_PORT ?? 5216);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "ticket-to-checkin.spec.ts",
  outputDir: "./e2e/.output/tickets",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/ticket-stack-server.mjs",
      url: `http://127.0.0.1:${STACK_PORT}/api/v1/me`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { TICKET_E2E_STACK_PORT: String(STACK_PORT) },
    },
    {
      command: `pnpm exec vite --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { VITE_API_BASE_URL: `http://127.0.0.1:${STACK_PORT}` },
    },
  ],
});
