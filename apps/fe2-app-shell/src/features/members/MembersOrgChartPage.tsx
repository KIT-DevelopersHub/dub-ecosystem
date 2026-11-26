// 組織図 — 統合アプリ「運営メンバー・名簿」の上タブの1つ（/members/org-chart）。
// 以前は 運営メンバー画面の内側タブ（チーム別 / 組織図）だったが、タブが二段で分かりにくい
// ため共有サブナビへ昇格した。表示専用（編集は 運営メンバー 画面）。印刷 / PNG はここに残す。
// 表示は「新しい表示」(チームを横に並べ、チームの中は左 → 右の木)と「これまでの表示」(#890 時点)を
// 切り替えられる。選んだ表示は閲覧者ごとに localStorage へ覚える(使えない環境では既定の新しい表示)。
import { useState } from "react";
import { Button, PageHeader, SegmentedControl, SkeletonLoader, ErrorState } from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useMembersOverview } from "./hooks.ts";
import { OrgChartView } from "./OrgChartView.tsx";
import { OrgChartLegacyView } from "./OrgChartLegacyView.tsx";
import styles from "./members.module.css";

export type OrgChartViewMode = "new" | "legacy";
export const ORG_CHART_VIEW_KEY = "dub.members.orgChartView";
const VIEW_OPTIONS = [
  { value: "new" as const, label: "新しい表示", testId: "members-orgchart-view-new" },
  { value: "legacy" as const, label: "これまでの表示", testId: "members-orgchart-view-legacy" },
];

function readViewMode(): OrgChartViewMode {
  try {
    return window.localStorage.getItem(ORG_CHART_VIEW_KEY) === "legacy" ? "legacy" : "new";
  } catch {
    return "new";
  }
}
function saveViewMode(mode: OrgChartViewMode): void {
  try {
    window.localStorage.setItem(ORG_CHART_VIEW_KEY, mode);
  } catch {
    // 保存できない環境(プライベートウィンドウ等)では、この画面の間だけ切り替える。
  }
}

export function MembersOrgChartPage(): JSX.Element {
  const overview = useMembersOverview();
  const [view, setView] = useState<OrgChartViewMode>(readViewMode);
  const changeView = (mode: OrgChartViewMode): void => {
    setView(mode);
    saveViewMode(mode);
  };

  if (overview.isPending) return <SkeletonLoader testId="members-orgchart-loading" />;
  if (overview.isError) {
    const display = ApiError.isApiError(overview.error)
      ? toDisplayableError(overview.error)
      : { code: "UNKNOWN", message: "読み込みに失敗しました", retryable: true };
    return <ErrorState error={display} onRetry={() => void overview.refetch()} />;
  }

  const teams = overview.data?.teams ?? [];
  // 辞退(declined)は出さない（運営メンバー画面のチーム別と母集団を揃える）。
  const members = (overview.data?.members ?? []).filter((m) => m.status !== "declined");

  return (
    <div data-testid="members-orgchart-page">
      <div className={styles.noPrint}>
        <PageHeader
          title="組織図"
          description="チームとリーダーの上下関係を一枚で表示します（組織図PDFの代替）"
          actions={
            <div className={styles.orgViewActions}>
              <SegmentedControl
                options={VIEW_OPTIONS}
                value={view}
                onChange={changeView}
                size="sm"
                aria-label="組織図の表示"
                testId="members-orgchart-view"
              />
              <Button variant="secondary" onClick={() => window.print()} testId="members-print">
                印刷 / PNG
              </Button>
            </div>
          }
        />
      </div>
      {view === "legacy" ? <OrgChartLegacyView teams={teams} members={members} /> : <OrgChartView teams={teams} members={members} />}
    </div>
  );
}
