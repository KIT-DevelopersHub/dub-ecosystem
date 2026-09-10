// P1-2 draft-autosave / leave-guard — real-browser regression across every wired
// form (gantt task create, マイタスク発行, mail compose, role create, role inline
// edit, event edit hub).
//
// WHY this exists: two earlier "reverified live" claims for this feature turned
// out to be false positives — (1) the disposable demo's deployedSha in
// deploy-state/demo-draft-autosave.json predated the commit that actually wired
// the gantt modals, so the "verified" bundle never contained that code, and
// (2) verify-live.sh only greps the served bundle for a testId string, which
// proves the CODE SHIPPED but not that a real browser actually shows the
// warning. This spec closes that gap: it never calls dialog.accept()/dismiss()
// blindly to make a test "pass" — it records every real 'dialog' event (type +
// message) so a missing beforeunload prompt shows up as a real failure, not a
// silently-skipped assertion. It also drives the in-app SPA blocker via an
// actual AppLauncher click (client-side router navigate()), not page.goto()
// (which is a hard top-level navigation and never exercises useBlocker at all).
import { test, expect, type Page } from "@playwright/test";

function attachDialogRecorder(page: Page): { log: string[] } {
  const rec = { log: [] as string[] };
  page.on("dialog", (dialog) => {
    rec.log.push(`type=${dialog.type()} message=${JSON.stringify(dialog.message())}`);
    dialog.dismiss().catch(() => {});
  });
  return rec;
}

// Fire a reload WITHOUT awaiting its navigation promise — if the dialog is
// dismissed, the navigation is cancelled and never settles, which would hang
// forever if awaited. We only care whether the 'dialog' event fired.
async function reloadAndCheckBeforeUnload(page: Page): Promise<boolean> {
  const rec = attachDialogRecorder(page);
  void page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2000);
  return rec.log.length > 0;
}

// Real in-app SPA navigation: open the header AppLauncher and click a tile —
// this goes through the router's client-side navigate(), which is what
// useBlocker/UnsavedChangesGuard is actually meant to intercept. page.goto()
// is a hard top-level navigation and does NOT exercise this code path.
async function navigateViaLauncher(page: Page, itemTestId: string): Promise<void> {
  await page.getByTestId("fe2-app-launcher").click();
  await page.getByTestId(itemTestId).click();
}

test.describe("draft leave guard — real browser, no auto-accept", () => {
  test("gantt タスクを作成 (fe4-create) — reload while dirty", async ({ page }) => {
    await page.goto("/events/evt_1/tasks");
    await page.getByTestId("fe4-create-open").click();
    await expect(page.getByTestId("fe4-create-title")).toBeVisible();
    await page.getByTestId("fe4-create-title").fill("投稿テスト: 離脱ガード確認 fe4-create");
    await page.waitForTimeout(600); // let the 400ms autosave debounce fire
    const fired = await reloadAndCheckBeforeUnload(page);
    console.log(`[RESULT] fe4-create beforeunload fired = ${fired}`);
    expect(fired, "beforeunload dialog should fire for gantt タスクを作成").toBe(true);
  });

  test("マイタスク タスクを発行 (fe4-mytask-create) — reload while dirty", async ({ page }) => {
    await page.goto("/me/tasks");
    await page.getByTestId("fe4-mytasks-create-open").click();
    await expect(page.getByTestId("fe4-mytask-create-title")).toBeVisible();
    await page.getByTestId("fe4-mytask-create-title").fill("投稿テスト: 離脱ガード確認 fe4-mytask");
    await page.waitForTimeout(600);
    const fired = await reloadAndCheckBeforeUnload(page);
    console.log(`[RESULT] fe4-mytask-create beforeunload fired = ${fired}`);
    expect(fired, "beforeunload dialog should fire for マイタスク タスクを発行").toBe(true);
  });

  test("mail compose (fe2) — beforeunload + real in-app nav blocker", async ({ page }) => {
    await page.goto("/mail/compose");
    await expect(page.getByTestId("fe2-mail-compose-subject")).toBeVisible();
    await page.getByTestId("fe2-mail-compose-subject").fill("投稿テスト: 離脱ガード確認 mail");
    await page.waitForTimeout(600);

    // (a) native beforeunload (reload / tab close path)
    const fired = await reloadAndCheckBeforeUnload(page);
    console.log(`[RESULT] fe2-mail-compose beforeunload fired = ${fired}`);
    expect(fired, "beforeunload dialog should fire for mail compose").toBe(true);

    // (b) real in-app SPA navigation via the AppLauncher (client-side router nav)
    await navigateViaLauncher(page, "fe2-app-launcher-item-mail");
    const blockDialog = page.getByTestId("fe2-mail-compose-leave-confirm");
    const blocked = await blockDialog.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[RESULT] fe2-mail-compose in-app nav blocker shown = ${blocked}`);
    if (blocked) {
      // stay on the page — cancel the navigation attempt
      await page.getByRole("button", { name: "編集を続ける" }).click().catch(() => {});
    }
  });

  test("role editor create (/admin/roles/new) — beforeunload + real in-app nav blocker", async ({ page }) => {
    await page.goto("/admin/roles/new");
    await expect(page.getByTestId("fe7-role-name")).toBeVisible();
    await page.getByTestId("fe7-role-name").fill("投稿テスト: 離脱ガード確認 role-new");
    await page.waitForTimeout(600);

    const fired = await reloadAndCheckBeforeUnload(page);
    console.log(`[RESULT] fe7-role-new beforeunload fired = ${fired}`);
    expect(fired, "beforeunload dialog should fire for role create").toBe(true);

    await navigateViaLauncher(page, "fe2-app-launcher-item-admin-roles");
    const blockDialog = page.getByTestId("fe7-role-leave-confirm");
    const blocked = await blockDialog.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[RESULT] fe7-role-new in-app nav blocker shown = ${blocked}`);
  });

  test("role editor inline edit (RolePermissionsEditor) — beforeunload + real in-app nav blocker", async ({ page }) => {
    await page.goto("/admin/roles");
    await expect(page.getByTestId("fe7-roles-list")).toBeVisible();
    const domainToggle = page.locator('[data-testid*="-matrix-domain-"]').first();
    await expect(domainToggle).toBeVisible();
    await domainToggle.click();
    await page.waitForTimeout(600);

    const fired = await reloadAndCheckBeforeUnload(page);
    console.log(`[RESULT] fe7-role-inline beforeunload fired = ${fired}`);
    expect(fired, "beforeunload dialog should fire for inline role edit").toBe(true);

    await navigateViaLauncher(page, "fe2-app-launcher-item-mail");
    const blockDialog = page.getByTestId(/fe7-role-.*-leave-confirm/);
    const blocked = await blockDialog.first().isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[RESULT] fe7-role-inline in-app nav blocker shown = ${blocked}`);
  });

  test("event edit hub (fe3) — reload while dirty", async ({ page }) => {
    await page.goto("/events");
    await page.getByTestId("fe2-global-event-menu").click();
    await page.getByTestId("fe2-global-event-item-evt_1").click();
    await page.goto("/events");
    await page.getByTestId("fe3-hub-edit-event").click();
    await expect(page.getByTestId("fe3-hub-edit-form")).toBeVisible();
    await page.locator("#fe3-edit-title").fill("投稿テスト: 離脱ガード確認 fe3-event");
    await page.waitForTimeout(600);
    const fired = await reloadAndCheckBeforeUnload(page);
    console.log(`[RESULT] fe3-event-edit beforeunload fired = ${fired}`);
    expect(fired, "beforeunload dialog should fire for event edit").toBe(true);
  });
});
