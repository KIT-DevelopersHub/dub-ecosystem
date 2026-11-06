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
