// Live verification against the DEPLOYED demo (not local vite). Proves all 5 gantt fixes
// on https://fe2-demo.developershub-site.workers.dev and screenshots each to ~/Desktop.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.LIVE_BASE ?? "https://fe2-demo.developershub-site.workers.dev";
const SHOTS = join(homedir(), "Desktop", "gantt-redo-shots", "live");
mkdirSync(SHOTS, { recursive: true });
const shot = (n) => join(SHOTS, n);
const PXD = 34;
const results = [];
const ok = (name, cond, extra = "") => { results.push([cond ? "PASS" : "FAIL", name, extra]); if (!cond) process.exitCode = 1; };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });

async function openGantt() {
  await p.goto(`${BASE}/events/evt_1/tasks/gantt`, { waitUntil: "networkidle" });
  await p.locator('[data-testid="fe4-gantt-view"]').waitFor({ state: "visible", timeout: 30000 });
  const day = p.locator('[data-testid="fe4-gantt-zoom-day"]');
  if (await day.count()) { await day.first().click(); await p.waitForTimeout(400); }
}
const barW = async (id) => p.locator(`[data-testid="fe4-gantt-bar-${id}"]`).evaluate((e) => e.getBoundingClientRect().width);
// Bring a bar clear of the sticky left pane so pointer coords land ON the bar (not the
// task-name gutter). Returns the bar's on-screen box.
async function bringBarIntoView(id) {
  const scroll = p.locator('[data-testid="fe4-gantt-scroll"]');
  const sbox = await scroll.boundingBox();
  const bar = p.locator(`[data-testid="fe4-gantt-bar-${id}"]`);
  await bar.scrollIntoViewIfNeeded().catch(() => {});
  let box = await bar.boundingBox();
  const wantX = sbox.x + 250;
  if (box.x < wantX) {
    await scroll.evaluate((el, d) => { el.scrollLeft += d; }, box.x - wantX);
    await p.waitForTimeout(300);
    box = await bar.boundingBox();
  }
  return box;
}

// 1. off-by-one
await openGantt();
await p.screenshot({ path: shot("01-gantt.png"), fullPage: true });
const w6 = await barW("tsk_6"), w3 = await barW("tsk_3");
ok("1 off-by-one: tsk_6 8 inclusive cells", Math.round(w6 / PXD) === 8, `${w6}px=${w6 / PXD}c`);
ok("1 off-by-one: tsk_3 6 inclusive cells", Math.round(w3 / PXD) === 6, `${w3}px=${w3 / PXD}c`);

// 5. #369 enclosure
await p.locator('[data-testid="fe4-gantt-toggle-tsk_1"]').click();
await p.waitForTimeout(400);
const encl = p.locator('[data-testid="fe4-gantt-group-tsk_1"]');
const enclVisible = await encl.count() && await encl.first().isVisible();
const border = enclVisible ? await encl.first().evaluate((e) => getComputedStyle(e).borderTopWidth) : "0px";
const bg = enclVisible ? await encl.first().evaluate((e) => getComputedStyle(e).backgroundColor) : "none";
await p.screenshot({ path: shot("05-enclosure.png"), fullPage: true });
ok("5 #369 parent enclosure bordered+tinted", enclVisible && parseFloat(border) > 0 && bg !== "rgba(0, 0, 0, 0)", `border=${border} bg=${bg}`);

// 2. #376 — drag leaf, no error + refetch; parent rollup
await openGantt();
let box = await bringBarIntoView("tsk_6");
const xBefore = box.x;
{
  const sx = box.x + box.width / 2, y = box.y + box.height / 2;
  await p.mouse.move(sx, y);
  await p.mouse.down();
  for (let i = 1; i <= 6; i++) { await p.mouse.move(sx + i * 24, y); await p.waitForTimeout(70); } // ~+4 days
  await p.waitForTimeout(150);
  await p.mouse.up();
  await p.waitForTimeout(600);
}
const errBanner = await p.locator('[data-testid="fe4-error-banner"]').count();
const serverErrText = await p.getByText("サーバーでエラーが発生しました").count();
const xAfter = (await p.locator('[data-testid="fe4-gantt-bar-tsk_6"]').boundingBox()).x;
await p.screenshot({ path: shot("02a-leaf-drag.png"), fullPage: true });
ok("2 #376 leaf drag: no server error", errBanner === 0 && serverErrText === 0, `banner=${errBanner} srvErr=${serverErrText}`);
ok("2 #376 leaf drag: bar physically moved right", Math.abs(xAfter - xBefore) > 3 * PXD, `Δx=${(xAfter - xBefore).toFixed(0)}px`);
// A real move does NOT auto-open the panel — open detail via the row label to read the refetched date.
await p.locator('[data-testid="fe4-gantt-row-tsk_6"]').click();
await p.waitForTimeout(400);
const leafStart = await p.locator('[data-testid="fe4-detail-start"]').inputValue().catch(() => "");
await p.screenshot({ path: shot("02a2-leaf-detail.png"), fullPage: true });
ok("2 #376 leaf drag: detail shows the NEW moved date (refetch, not stale 2026-08-01)",
   leafStart !== "" && leafStart !== "2026-08-01", `start=${leafStart}`);
// parent rollup
await openGantt();
await p.locator('[data-testid="fe4-gantt-row-tsk_1"]').click();
await p.waitForTimeout(400);
const pStart = await p.locator('[data-testid="fe4-detail-start"]').inputValue().catch(() => "");
const pDue = await p.locator('[data-testid="fe4-detail-due"]').inputValue().catch(() => "");
await p.screenshot({ path: shot("02b-parent-rollup.png"), fullPage: true });
// parent's OWN seeded column is 2026-07-28/08-03; child rollup is 2026-07-25/08-02 → proves rollup shown
ok("2 #376 parent detail = child rollup (not stale own column)", pStart === "2026-07-25" && pDue === "2026-08-02", `start=${pStart} due=${pDue}`);

// 3a. #375 parent blocked
await openGantt();
await p.locator('[data-testid="fe4-gantt-row-tsk_1"]').click();
await p.locator('[data-testid="fe4-detail-delete"]').click();
const blocked = p.locator('[data-testid="fe4-delete-blocked"]');
const blockedVisible = await blocked.count() && await blocked.first().isVisible();
const blockedText = blockedVisible ? await blocked.first().innerText() : "";
const confirmCount = await p.locator('[data-testid="fe4-confirm-delete"]').count();
await p.screenshot({ path: shot("03a-parent-blocked.png"), fullPage: true });
ok("3a #375 parent WITH children blocked", blockedVisible && /子タスク.*削除できません/s.test(blockedText) && confirmCount === 0, blockedText.replace(/\n/g, " ").slice(0, 60));

// 3b. #375 leaf deletable
await openGantt();
await p.locator('[data-testid="fe4-gantt-row-tsk_2"]').click();
await p.locator('[data-testid="fe4-detail-delete"]').click();
const confirmVisible = await p.locator('[data-testid="fe4-confirm-delete"]').first().isVisible();
const blockedCount = await p.locator('[data-testid="fe4-delete-blocked"]').count();
await p.screenshot({ path: shot("03b-leaf-deletable.png"), fullPage: true });
ok("3b #375 leaf WITHOUT children deletable", confirmVisible && blockedCount === 0);

// 4. #372 chat delete 4-step
await p.goto(`${BASE}/admin/roles`, { waitUntil: "networkidle" });
await p.locator('[data-testid="fe7-roles-list"]').waitFor({ state: "visible", timeout: 30000 });
const openMember = p.locator('[data-testid="fe7-roles-open-role_member"]');
if (await openMember.count()) await openMember.click(); else await p.locator('[data-testid="fe7-roles-open-role_admin"]').click();
await p.waitForTimeout(800);
const labels = ["削除不可", "リアクション付きは削除不可", "自分の投稿のみ削除", "全員の投稿を削除"];
const counts = {};
for (const l of labels) counts[l] = await p.getByText(l, { exact: false }).count();
await p.screenshot({ path: shot("04-chat-delete-4step.png"), fullPage: true });
ok("4 #372 chat delete 4-step labels all present", labels.every((l) => counts[l] > 0), JSON.stringify(counts));

console.log("\n===== LIVE DEMO VERIFICATION =====");
console.log("URL:", BASE);
for (const [s, n, e] of results) console.log(`  [${s}] ${n}${e ? "  (" + e + ")" : ""}`);
if (errors.length) console.log("console.errors:", [...new Set(errors)].slice(0, 5));
console.log("shots:", SHOTS);
await b.close();
