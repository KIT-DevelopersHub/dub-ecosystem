// Real-browser proof of the roster inline-role feature against the mock-backed harness:
//   1. the ロール column renders each member's roles as chips,
//   2. an admin grants a role IN THE LIST (chip appears, optimistically),
//   3. an admin revokes a role IN THE LIST (chip disappears),
//   4. a read-only viewer sees chips but no inline edit affordance.
// Screenshots are written next to the spec (and copied to the Desktop by the runner).
import { test, expect } from "@playwright/test";

test("admin sees a ロール column and edits roles inline in the list", async ({ page }) => {
  await page.goto("/");

  // The roster table + ロール column header render.
  await expect(page.getByTestId("fe7-users-table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "ロール" })).toBeVisible();

  // Seeded chips: Alice = admin, Bob = member, Carol = none.
  await expect(page.getByTestId("fe7-role-chip-user_alice-role_admin")).toHaveText("admin");
  await expect(page.getByTestId("fe7-role-chip-user_bob-role_member")).toHaveText("member");
  await expect(page.getByTestId("fe7-roles-empty-user_carol")).toBeVisible();
  await page.screenshot({ path: "e2e/.output/01-roles-column.png", fullPage: true });

  // GRANT: click Carol's roles cell (the chips ARE the trigger — no 編集 button),
  // toggle "member" on -> chip appears instantly.
  const carolEdit = page.getByTestId("fe7-user-roles-user_carol").getByRole("button", { name: "ロールを編集" });
  await carolEdit.click();
  await page.getByTestId("fe7-inline-role-toggle-user_carol-role_member").click();
  await expect(page.getByTestId("fe7-role-chip-user_carol-role_member")).toBeVisible();
  await page.screenshot({ path: "e2e/.output/02-inline-grant.png", fullPage: true });
  await carolEdit.click(); // close the popover so it doesn't overlay other rows
  await expect(page.getByTestId("fe7-inline-role-panel-user_carol")).toHaveCount(0);

  // REVOKE: click Bob's roles cell, uncheck "member" -> chip disappears.
  await page.getByTestId("fe7-user-roles-user_bob").getByRole("button", { name: "ロールを編集" }).click();
  const bobToggle = page.getByTestId("fe7-inline-role-toggle-user_bob-role_member");
  await expect(bobToggle).toBeEnabled(); // waits for the lazy assignment fetch
  await bobToggle.click();
  await expect(page.getByTestId("fe7-role-chip-user_bob-role_member")).toHaveCount(0);
  await page.screenshot({ path: "e2e/.output/03-inline-revoke.png", fullPage: true });
});

test("read-only viewer sees role chips but no inline edit", async ({ page }) => {
  await page.goto("/?readonly=1");

  await expect(page.getByTestId("fe7-role-chip-user_alice-role_admin")).toBeVisible();
  // No inline-edit affordance anywhere for a viewer without identity:admin.
  await expect(page.getByRole("button", { name: "ロールを編集" })).toHaveCount(0);
  await expect(page.getByTestId("fe7-users-invite")).toHaveCount(0);
  await page.screenshot({ path: "e2e/.output/04-readonly.png", fullPage: true });
});
