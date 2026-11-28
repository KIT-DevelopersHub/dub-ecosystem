// 既存機能の総点検（#852）。主要フローを 1360px と 390px の 2 幅で通す。
//   pnpm e2e:smoke                       … ローカルの demo（VITE_DEMO）。送信など書き込み系も通す
//   SMOKE_BASE_URL=<staging の URL> pnpm e2e:smoke
//                                        … 立っている環境を読み取りだけで見る（送信・保存はしない）
// 公開 LP は SMOKE_PUBLIC_LP_URL を渡した時だけ見る。スクショの置き場は SMOKE_SHOTS で変えられる。
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5217);
const REMOTE = process.env.SMOKE_BASE_URL;

export default defineConfig({
  testDir: "./e2e/smoke-all",
  outputDir: "./e2e/.output/smoke-all",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: REMOTE ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-1360", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } },
    { name: "mobile-390", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  ...(REMOTE
    ? {}
    : {
        webServer: {
          command: `pnpm exec vite --port ${PORT} --strictPort`,
          url: `http://localhost:${PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: { VITE_DEMO: "1" },
        },
      }),
});
