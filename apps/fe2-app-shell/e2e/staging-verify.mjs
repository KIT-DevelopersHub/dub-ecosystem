// STAGING verification (REAL backend — dub-*-staging Workers + real D1/KV). Logs into the
// staging fe2 as the seeded admin, then proves the 3 approved items on the real stack and
// screenshots each. The point of staging (vs the backend-free demo) is #376: a real bar
// drag hits the real gantt-service + KV, so a 500/429 would actually surface here.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FE2 = process.env.FE2 ?? "https://dub-fe2-app-shell-staging.developershub-site.workers.dev";
const EV = "event_01SEED000000000000000CONF0";
const EMAIL = "demo-admin@developershub.jp";
const PW = "StagingVerify-2026";
const PXD = 34;
const SHOTS = join(homedir(), "Desktop", "gantt-redo-shots", "staging");
mkdirSync(SHOTS, { recursive: true });
const shot = (n) => join(SHOTS, n);
const results = [];
const ok = (n, c, e = "") => { results.push([c ? "PASS" : "FAIL", n, e]); if (!c) process.exitCode = 1; };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
// Capture REAL server failures on the gantt write path (the whole point of staging).
const badResponses = [];   // 5xx/429 on the gantt WRITE path specifically (the #376 concern)
const allServerErrs = [];   // any 5xx/429 anywhere, to attribute a stray "サーバーでエラー" toast
p.on("response", (r) => {
  const u = r.url(); const s = r.status();
  if (/\/gantt\/rows\//.test(u) && (s >= 500 || s === 429)) badResponses.push(`${s} ${u}`);
  // Any non-2xx except the expected unauthenticated probes, to attribute a stray toast.
  if (s >= 400 && !/\/api\/v1\/me$|\/auth\/refresh$/.test(u)) allServerErrs.push(`${s} ${u.replace(/https:\/\/[^/]+/, "")}`);
});
const consoleErrors = [];
p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });

async function login() {
  await p.goto(`${FE2}/login`, { waitUntil: "networkidle" });
  await p.locator('[data-testid="fe2-login-email"]').fill(EMAIL);
  await p.locator('[data-testid="fe2-login-password"]').fill(PW);
  await p.locator('[data-testid="fe2-login-submit"]').click();
  await p.waitForTimeout(4000); // session established + shell loads (+ avoids a redirect race)
}
async function openGantt() {
  await p.goto(`${FE2}/events/${EV}/tasks/gantt`, { waitUntil: "networkidle" });
  await p.locator('[data-testid="fe4-gantt-view"]').waitFor({ state: "visible", timeout: 30000 });
  const day = p.locator('[data-testid="fe4-gantt-zoom-day"]');
  if (await day.count()) { await day.first().click(); await p.waitForTimeout(500); }
}
async function bringBarIntoView(id) {
  const scroll = p.locator('[data-testid="fe4-gantt-scroll"]');
  const sbox = await scroll.boundingBox();
  const bar = p.locator(`[data-testid="fe4-gantt-bar-${id}"]`);
  await bar.scrollIntoViewIfNeeded().catch(() => {});
  let box = await bar.boundingBox();
  const wantX = sbox.x + 300;
  if (box && box.x < wantX) {
    await scroll.evaluate((el, d) => { el.scrollLeft += d; }, box.x - wantX);
    await p.waitForTimeout(300);
    box = await bar.boundingBox();
  }
  return box;
}

await login();
// 1. off-by-one — task "Demo task 2" (BLOCK) spans 2026-07-22 → 2026-07-25 = 4 inclusive days.
await openGantt();
// Reaching the auth-gated gantt proves the real login worked (allowlist + password).
const loggedIn = (await p.locator('[data-testid="fe4-gantt-view"]').count()) > 0 && !/\/login/.test(p.url());
ok("0 staging login (real auth allowlist + password)", loggedIn, `url=${p.url().replace(FE2, "")}`);
await p.screenshot({ path: shot("01-gantt.png"), fullPage: true });
const wBlock = await p.locator('[data-testid="fe4-gantt-bar-task_01SEED00000000000000BLOCK"]').evaluate((e) => e.getBoundingClientRect().width).catch(() => 0);
ok("1 off-by-one: 4-day task = 4 inclusive cells", Math.round(wBlock / PXD) === 4, `${wBlock}px=${(wBlock / PXD).toFixed(2)}c`);

// 2. #376 — drag a leaf bar on the REAL backend: no 500/429, and detail refetches the new date.
const DRAG_ID = "task_seed_06"; // "Demo task 7" — seeded start 2026-08-12 (leaf, near today)
const startBefore = "2026-08-12"; // known seed start (avoid opening detail before the drag)
const box = await bringBarIntoView(DRAG_ID);
{
  const sx = box.x + box.width / 2, y = box.y + box.height / 2;
  await p.mouse.move(sx, y); await p.mouse.down();
  for (let i = 1; i <= 6; i++) { await p.mouse.move(sx + i * 24, y); await p.waitForTimeout(80); } // ~+4 days
  await p.waitForTimeout(150); await p.mouse.up();
  await p.waitForTimeout(2000); // let the real PATCH round-trip + refetch settle
}
const xAfter = (await p.locator(`[data-testid="fe4-gantt-bar-${DRAG_ID}"]`).boundingBox().catch(() => null))?.x ?? box.x;
const errBanner = await p.locator('[data-testid="fe4-error-banner"]').count();
const srvErr = await p.getByText("サーバーでエラーが発生しました").count();
await p.screenshot({ path: shot("02a-drag.png"), fullPage: true });
ok("2 #376 real drag: NO 500/429 from gantt-service", badResponses.length === 0, badResponses.join("; ") || "clean");
ok("2 #376 real drag: no error banner / server-error toast", errBanner === 0 && srvErr === 0, `banner=${errBanner} srvErr=${srvErr}`);
ok("2 #376 real drag: bar physically moved", Math.abs(xAfter - box.x) > 3 * PXD, `Δx=${(xAfter - box.x).toFixed(0)}px`);
// open detail → the refetched (persisted) date must differ from before the drag
await p.locator(`[data-testid="fe4-gantt-row-${DRAG_ID}"]`).click();
await p.waitForTimeout(600);
const startAfter = await p.locator('[data-testid="fe4-detail-start"]').inputValue().catch(() => "");
await p.screenshot({ path: shot("02b-detail-refetch.png"), fullPage: true });
ok("2 #376 real drag: detail shows the NEW persisted date (refetch)", startAfter !== "" && startAfter !== startBefore, `before=${startBefore} after=${startAfter}`);
await p.keyboard.press("Escape").catch(() => {});

// 4. #372 — chat delete 4-step segmented control in role management.
const labels = ["削除不可", "リアクション付きは削除不可", "自分の投稿のみ削除", "全員の投稿を削除"];
const counts = {};
try {
  await p.goto(`${FE2}/admin/roles`, { waitUntil: "networkidle" });
  await p.locator('[data-testid="fe7-roles-list"]').waitFor({ state: "visible", timeout: 30000 });
  // Real roster role ids differ from the demo's — open whichever role is first in the list.
  const opener = p.locator('[data-testid^="fe7-roles-open-"]').first();
  await opener.click();
  await p.waitForTimeout(1200);
  for (const l of labels) counts[l] = await p.getByText(l, { exact: false }).count();
  await p.screenshot({ path: shot("04-chat-delete-4step.png"), fullPage: true });
} catch (e) {
  counts._error = String(e).slice(0, 80);
  await p.screenshot({ path: shot("04-chat-delete-ERROR.png"), fullPage: true }).catch(() => {});
}
ok("4 #372 chat delete 4-step labels present (real roster)", labels.every((l) => counts[l] > 0), JSON.stringify(counts));

console.log("\n===== STAGING (REAL BACKEND) VERIFICATION =====");
console.log("fe2:", FE2);
for (const [s, n, e] of results) console.log(`  [${s}] ${n}${e ? "  (" + e + ")" : ""}`);
if (badResponses.length) console.log("  gantt-write 5xx/429:", badResponses);
if (allServerErrs.length) console.log("  ALL 5xx/429 (any endpoint):", [...new Set(allServerErrs)]);
console.log("shots:", SHOTS);
await b.close();
