// チケット E2E（#897）のスタックを HTTP で立てる。playwright.tickets.config.ts の webServer から起動する。
// packages/e2e-smoke の TS（@dub/* はビルド無しでソースを解決）を vite の SSR で読み込む。
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const port = Number(process.env.TICKET_E2E_STACK_PORT ?? 5216);
const smoke = fileURLToPath(new URL("../../../packages/e2e-smoke/", import.meta.url));

const vite = await createServer({
  root: smoke,
  configFile: `${smoke}vitest.config.ts`,
  appType: "custom",
  logLevel: "warn",
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { startTicketServer } = await vite.ssrLoadModule(`${smoke}src/ticket-server.ts`);
await startTicketServer(port);
console.log(`ticket E2E stack on http://127.0.0.1:${port}`);
