// Standalone Playwright E2E for 運営名簿のダウンロード(Excel/CSV/PDF), run with `node`
// against a VITE_DEMO build (E2E_FE2, e.g. a disposable demo URL). Starts from the home
// screen and navigates by clicks, then saves each download to E2E_OUT for inspection.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FE2 = process.env.E2E_FE2 ?? "http://localhost:5312";
const OUT = process.env.E2E_OUT ?? "/tmp/roster-export-e2e";
mkdirSync(OUT, { recursive: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text()); });

try {
  await page.goto(FE2, { waitUntil: "networkidle" });
  await page.locator('a[href="/members"]').first().click();
  await page.getByTestId("members-page").waitFor({ timeout: 15000 });
  await page.getByTestId("member-roster-subnav").getByRole("tab", { name: "運営名簿" }).first().click();
  await page.getByTestId("member-roster-page").waitFor({ timeout: 15000 });
  await page.getByTestId("members-table").waitFor();
  const rowCount = await page.getByTestId("members-table").locator("tbody tr").count();
  ok(`reached 運営名簿 from home (${rowCount} rows)`);

  await page.getByTestId("member-roster-export-trigger").click();
  await page.screenshot({ path: join(OUT, "menu-open.png") });

  for (const fmt of ["xlsx", "csv", "pdf"]) {
    if (!(await page.getByTestId(`member-roster-export-${fmt}`).isVisible())) {
      await page.getByTestId("member-roster-export-trigger").click();
    }
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId(`member-roster-export-${fmt}`).click()]);
    const name = dl.suggestedFilename();
    if (!name.endsWith(`.${fmt}`)) fail(`${fmt}: unexpected filename ${name}`);
    const path = join(OUT, `roster.${fmt}`);
    await dl.saveAs(path);
    const buf = readFileSync(path);
    if (buf.length < 100) fail(`${fmt}: file too small (${buf.length}B)`);
    ok(`${fmt}: ${name} (${buf.length} bytes)`);
    if (fmt === "csv") {
      const lines = buf.toString("utf8").trim().split("\r\n");
      if (lines.length !== rowCount + 1) fail(`csv: ${lines.length - 1} data rows, table shows ${rowCount}`);
      ok(`csv rows match the table (${rowCount})`);
    }
  }
  ok("all downloads succeeded");
} finally {
  await browser.close();
}
