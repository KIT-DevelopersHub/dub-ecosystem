// 組織図 — 統合アプリ「運営メンバー・名簿」の上タブの1つ（/members/org-chart）。
// 以前は 運営メンバー画面の内側タブ（チーム別 / 組織図）だったが、タブが二段で分かりにくい
// ため共有サブナビへ昇格した。表示専用（編集は 運営メンバー 画面）。印刷 / PNG はここに残す。
import { Button, PageHeader, SkeletonLoader, ErrorState } from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useMembersOverview } from "./hooks.ts";
import { OrgChartView } from "./OrgChartView.tsx";
import styles from "./members.module.css";

export function MembersOrgChartPage(): JSX.Element {
  const overview = useMembersOverview();

  if (overview.isLoading) return <SkeletonLoader testId="members-orgchart-loading" />;
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
            <Button variant="secondary" onClick={() => window.print()} testId="members-print">
              印刷 / PNG
            </Button>
          }
        />
      </div>
      <OrgChartView teams={teams} members={members} />
    </div>
  );
}
