// 参加者 section of the meeting detail: who is invited and how they answered in Google Calendar
// (参加 / 不参加 / 未定 / 未返信), like Google Calendar's guest list.
import { Avatar, Badge, Button, SkeletonList } from "@dub/ui";
import type { BadgeTone } from "@dub/ui";
import { meeting } from "@dub/types";
import { useMeetingAttendeesQuery, useResyncMeetingMutation } from "./useMeetings.tsx";

const TONE: Record<meeting.MeetingResponseStatus, BadgeTone> = {
  accepted: "success",
  tentative: "warning",
  declined: "danger",
  needsAction: "neutral",
};
const ORDER: readonly meeting.MeetingResponseStatus[] = ["accepted", "tentative", "declined", "needsAction"];

const muted = { color: "var(--dub-color-text-muted)", fontSize: "var(--dub-font-size-xs)" } as const;

const NOT_INVITED: Record<meeting.MeetingNotInvitedReason, { label: string; tone: BadgeTone }> = {
  no_email: { label: "メールアドレス未連携", tone: "warning" },
  pending: { label: "未招待", tone: "neutral" },
};

/** `canResync`: show 参加者を再同期 (ミーティング編集 holders). */
export function MeetingAttendees({ meetingId, date, canResync = false }: { meetingId: string; date: string | undefined; canResync?: boolean }): JSX.Element {
  const q = useMeetingAttendeesQuery(meetingId, date);
  const resync = useResyncMeetingMutation(meetingId);
  const tid = "calendar-meeting-attendees";
  const items = q.data?.items ?? [];
  const notInvited = q.data?.notInvited ?? [];
  const showAnswers = q.data?.responsesAvailable ?? false;
  const count = (s: meeting.MeetingResponseStatus) => items.filter((i) => i.response === s).length;

  return (
    <section
      aria-label="参加者"
      data-testid={tid}
      style={{ display: "flex", flexDirection: "column", gap: "var(--dub-space-2)", paddingTop: "var(--dub-space-3)", borderTop: "1px solid var(--dub-color-border-default)", marginTop: "var(--dub-space-2)" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--dub-space-3)", flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--dub-font-size-sm)", fontWeight: "var(--dub-font-weight-medium)", color: "var(--dub-color-text-primary)" }}>
          参加者{q.data ? ` ${items.length}人` : ""}
        </span>
        {q.data && showAnswers && items.length > 0 ? (
          <span style={muted} data-testid={`${tid}-summary`}>
            {ORDER.filter((s) => count(s) > 0)
              .map((s) => `${meeting.MEETING_RESPONSE_LABELS[s]} ${count(s)}`)
              .join(" · ")}
          </span>
        ) : null}
        {canResync ? (
          <span style={{ marginLeft: "auto" }}>
            <Button variant="ghost" size="sm" onClick={() => resync.mutate()} loading={resync.isPending} testId={`${tid}-resync`}>
              参加者を再同期
            </Button>
          </span>
        ) : null}
      </div>

      {q.isPending ? (
        <SkeletonList rows={3} avatar testId={`${tid}-loading`} />
      ) : q.isError ? (
        <span style={muted} data-testid={`${tid}-error`}>
          参加者を読み込めませんでした。時間をおいて開き直してください。
        </span>
      ) : items.length === 0 ? (
        <span style={muted} data-testid={`${tid}-empty`}>
          招待されているメンバーはいません。
        </span>
      ) : (
        <>
          {!showAnswers ? (
            <span style={muted} data-testid={`${tid}-unavailable`}>
              Google カレンダーから出欠を読み込めなかったため、返信状況は表示していません。
            </span>
          ) : null}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--dub-space-2)", maxHeight: "16rem", overflowY: "auto" }}>
            {items.map((a, i) => (
              <li key={a.userId ?? a.email ?? i} data-testid={`${tid}-row`} style={{ display: "flex", alignItems: "center", gap: "var(--dub-space-3)" }}>
                <Avatar name={a.name} size="sm" />
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: "var(--dub-font-size-sm)", color: "var(--dub-color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.name}
                    {a.userId === null ? <span style={{ ...muted, marginLeft: "var(--dub-space-2)" }}>ゲスト</span> : null}
                  </span>
                  {a.email && a.email !== a.name ? <span style={muted}>{a.email}</span> : null}
                  {showAnswers && a.comment ? <span style={{ ...muted, whiteSpace: "pre-wrap" }}>「{a.comment}」</span> : null}
                </div>
                {showAnswers ? (
                  <Badge tone={TONE[a.response]} testId={`${tid}-response`}>
                    {meeting.MEETING_RESPONSE_LABELS[a.response]}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {notInvited.length > 0 ? (
        <div data-testid={`${tid}-not-invited`} style={{ display: "flex", flexDirection: "column", gap: "var(--dub-space-2)", paddingTop: "var(--dub-space-2)" }}>
          <span style={{ fontSize: "var(--dub-font-size-sm)", color: "var(--dub-color-text-primary)" }}>
            招待できていないメンバー {notInvited.length}人
          </span>
          {notInvited.some((n) => n.reason === "no_email") ? (
            <span style={muted}>名簿に Gmail が登録されていない（または名簿とアカウントがつながっていない）ため、招待を送れません。名簿で Gmail を登録すると次の同期で招待されます。</span>
          ) : null}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--dub-space-2)" }}>
            {notInvited.map((n) => (
              <li key={n.userId} data-testid={`${tid}-not-invited-row`} style={{ display: "flex", alignItems: "center", gap: "var(--dub-space-3)" }}>
                <Avatar name={n.name} size="sm" />
                <span style={{ flex: 1, minWidth: 0, fontSize: "var(--dub-font-size-sm)", color: "var(--dub-color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {n.name}
                </span>
                <Badge tone={NOT_INVITED[n.reason].tone} testId={`${tid}-not-invited-reason`}>
                  {NOT_INVITED[n.reason].label}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
