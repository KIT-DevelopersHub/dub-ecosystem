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

test("the sponsor goals tab sets the target of a linked KPI", async ({ page }) => {
  await page.goto("/sponsor/goals");
  await page.getByTestId("fe2-sponsor-goal-edit").click();
  await page.getByTestId("fe2-sponsor-goal-field-contacted").fill("30");
  await page.getByTestId("fe2-sponsor-goal-save").click();
  await page.getByTestId("fe2-sponsor-goals-link").getByRole("link", { name: "目標管理" }).waitFor();

  // リンクはページ遷移なので demo のメモリが消える。アプリ内の移動で確かめる。
  await page.evaluate(() => {
    window.history.pushState({}, "", "/goals");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const sponsor = page.getByTestId("fe2-goals-team-team_sponsor");
  await expect(sponsor.getByText("9社 / 30社")).toBeVisible();
  await expect(sponsor.getByText(/目標は目標タブと連動/).first()).toBeVisible();

  await page.getByTestId("fe2-goals-edit-team_sponsor").click();
  await expect(page.getByTestId("fe2-goals-kpi-target-0")).toBeDisabled();
  await expect(page.getByTestId("fe2-goals-kpi-target-0")).toHaveValue("30");
});
