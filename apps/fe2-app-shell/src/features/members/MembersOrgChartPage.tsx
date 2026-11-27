// 組織図 — 運営メンバータブの表示切り替えの1つ（/members/org-chart・#901）。
// 同じ人たちを チーム別 / 一覧表 / 組織図 で見せ分ける。切り替えは共有サブナビ(MemberRosterNav)
// の右側。表示専用（編集は チーム別 / 一覧表）。印刷 / PNG はここに残す。
import { Button, PageHeader, SkeletonLoader, ErrorState } from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useScopedOverview } from "./hooks.ts";
import { useEventTitle } from "../../lib/eventTarget.tsx";
import { OrgChartView } from "./OrgChartView.tsx";
import styles from "./members.module.css";

export function MembersOrgChartPage(): JSX.Element {
  // イベントを選んでいる時は、そのイベントの運営メンバー・班だけ。
  const overview = useScopedOverview();
  const eventTitle = useEventTitle(overview.eventId);

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
          description={
            overview.eventId
              ? `「${eventTitle ?? "選択中のイベント"}」の運営メンバーと班だけを表示しています（運営メンバー画面で全体の名簿から選べます）`
              : "チームとリーダーの上下関係を一枚で表示します（組織図PDFの代替）"
          }
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
