// 目標管理 E2E (demo build)。チームの進捗が見え、目標を作ると % が出て、月を移動できる。
import { expect, test } from "@playwright/test";

test("sets a team goal and shows the progress percent", async ({ page }) => {
  await page.goto("/goals");
  await expect(page.getByTestId("fe2-goals-screen")).toBeVisible();

  const dev = page.getByTestId("fe2-goals-team-team_dev");
  await expect(dev.getByText("タスクから自動集計").first()).toBeVisible();
  await expect(page.getByTestId("fe2-goals-percent-team_dev")).toHaveText(/\d+%/);

  await page.getByTestId("fe2-goals-set-team_venue").click();
  await page.getByTestId("fe2-goals-title").fill("設営の準備を終える");
  await page.getByTestId("fe2-goals-kpi-metric-0").selectOption("manual");
  await page.getByTestId("fe2-goals-kpi-target-0").fill("8");
  await page.getByTestId("fe2-goals-kpi-actual-0").fill("2");
  await page.getByTestId("fe2-goals-save").click();

  await expect(page.getByTestId("fe2-goals-percent-team_venue")).toHaveText("25%");

  const label = await page.getByTestId("fe2-goals-month").textContent();
  await page.getByTestId("fe2-goals-prev").click();
  await expect(page.getByTestId("fe2-goals-month")).not.toHaveText(label ?? "");
  await expect(page.getByTestId("fe2-goals-team-team_venue").getByText("この月の目標は未設定です")).toBeVisible();
});

test("a target set in the goals app shows on the read-only sponsor tab", async ({ page }) => {
  await page.goto("/goals");
  await page.getByTestId("fe2-goals-edit-team_sponsor").click();
  await expect(page.getByTestId("fe2-goals-kpi-target-0")).toBeEnabled();
  await page.getByTestId("fe2-goals-kpi-target-0").fill("30");
  await page.getByTestId("fe2-goals-save").click();
  const actual = (await page.getByTestId("fe2-goals-team-team_sponsor").getByText(/\d+社 \/ 30社/).textContent())?.match(/^\d+/)?.[0];

  // リンクはページ遷移なので demo のメモリが消える。アプリ内の移動で確かめる。
  await page.evaluate(() => {
    window.history.pushState({}, "", "/sponsor/goals");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByTestId("fe2-sponsor-goal-contacted")).toContainText("/ 30 社");
  await expect(page.getByTestId("fe2-sponsor-goal-actual-contacted")).toHaveText(`${actual} 社`);
  await expect(page.getByTestId("fe2-sponsor-goal-edit")).toHaveCount(0);
  await expect(page.getByTestId("fe2-sponsor-goals-link").getByRole("link", { name: "目標管理" })).toBeVisible();
});

test("the save button stays reachable with many KPIs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/goals");
  await page.getByTestId("fe2-goals-set-team_venue").click();
  await page.getByTestId("fe2-goals-title").fill("設営の準備を終える");
  for (let i = 0; i < 5; i += 1) await page.getByTestId("fe2-goals-kpi-add").click();
  for (let i = 0; i < 6; i += 1) await page.getByTestId(`fe2-goals-kpi-target-${i}`).fill("5");
  await page.getByTestId("fe2-goals-save").click();
  await expect(page.getByTestId("fe2-goals-drawer")).toBeHidden();
  await expect(page.getByTestId("fe2-goals-percent-team_venue")).toHaveText(/\d+%/);
});
