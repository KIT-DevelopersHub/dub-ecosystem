// メーリングリスト管理の実ブラウザ検証 (demo: mock backend)。
// Usage: E2E_BASE=https://dub-demo-team-lists.developershub-site.workers.dev node e2e/team-mailing-lists-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.E2E_BASE ?? "http://localhost:5174";
const SHOTS = process.env.E2E_OUT ?? "/tmp/team-mailing-lists-e2e";
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const dialog = page.getByTestId("fe7-team-lists-dialog");

await page.goto(`${BASE}/admin/users`, { waitUntil: "networkidle" });
await page.getByTestId("fe7-users-team-lists").click();
await dialog.getByTestId("fe7-team-lists-empty").waitFor();
await dialog.screenshot({ path: `${SHOTS}/01-empty.png` });

const select = dialog.getByTestId("fe7-team-list-team");
const teamValue = await select.locator("option:not([value=''])").first().getAttribute("value");
await select.selectOption(teamValue);
const localPart = await dialog.getByTestId("fe7-team-list-localpart").inputValue();
if (!localPart) throw new Error("address was not prefilled from the team");
await dialog.getByTestId("fe7-team-list-submit").click();
const row = dialog.locator('[data-testid^="fe7-team-list-row-"]').first();
await row.getByText(`${localPart}@developershub.jp`).waitFor();
const reach = await row.innerText();
if (!/受信できる人 \d+ \/ \d+ 人/.test(reach)) throw new Error(`no reach label: ${reach}`);
await dialog.screenshot({ path: `${SHOTS}/02-created.png` });

await row.getByRole("button", { name: "削除" }).click();
await page.getByRole("button", { name: "削除する" }).click();
await dialog.getByTestId("fe7-team-lists-empty").waitFor();
await dialog.screenshot({ path: `${SHOTS}/03-deleted.png` });

await browser.close();
if (errors.length > 0) throw new Error(`page errors: ${errors.join(" | ")}`);
console.log(`PASS ${localPart}@developershub.jp — ${reach.replace(/\s+/g, " ")}`);
