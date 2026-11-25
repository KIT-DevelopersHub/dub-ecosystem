// Meeting detail shown when a meeting chip is clicked: when / who (with Google Calendar answers) /
// Meet link, plus edit + delete (with confirmation) for meetings_edit holders.
import { useState } from "react";
import { Button, ConfirmDialog, Modal } from "@dub/ui";
import type { meeting } from "@dub/types";
import { formatOccurrence, jstParts, recurrenceLabel } from "./meeting-occurrences";
import { MeetingAttendees } from "./MeetingAttendees.tsx";

const row = { display: "flex", gap: "var(--dub-space-4)", padding: "var(--dub-space-2) 0", alignItems: "baseline" } as const;
const label = { color: "var(--dub-color-text-muted)", minWidth: "5.5rem", fontSize: "var(--dub-font-size-sm)" } as const;
const value = { color: "var(--dub-color-text-primary)", fontSize: "var(--dub-font-size-sm)", wordBreak: "break-word" } as const;

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function MeetingDetailDialog({
  occurrence,
  canEdit,
  onClose,
  onEdit,
  onDelete,
  onJoin,
}: {
  /** The clicked occurrence (meeting + its start). null = closed. */
  occurrence: { meeting: meeting.Meeting; startsAt: string } | null;
  canEdit: boolean;
  onClose: () => void;
  onEdit: (m: meeting.Meeting) => void;
  onDelete: (m: meeting.Meeting) => void;
  /** Join through Dub (records attendance for a 定例). Absent = open the Meet link directly. */
  onJoin?: (m: meeting.Meeting) => void;
}): JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  if (!occurrence) return null;
  const m = occurrence.meeting;
  const firstDate = jstParts(m.startsAt)?.date ?? "";
  const pending = m.id.startsWith("tmp_");
  const tid = "calendar-meeting-detail";

  return (
    <>
      <Modal
        open={!confirming}
        onClose={onClose}
        title={m.title}
        size="sm"
        testId={tid}
        footer={
          <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--dub-space-3)", flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: "var(--dub-space-2)" }}>
              {canEdit ? (
                <>
                  <Button variant="ghost" onClick={() => setConfirming(true)} disabled={pending} testId={`${tid}-delete`}>
                    削除
                  </Button>
                  <Button variant="secondary" onClick={() => onEdit(m)} disabled={pending} testId={`${tid}-edit`}>
                    編集
                  </Button>
                </>
              ) : null}
            </div>
            <Button variant="ghost" onClick={onClose}>
              閉じる
            </Button>
          </div>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--dub-space-1)" }}>
          <div style={row}>
            <span style={label}>日時</span>
            <span style={value} data-testid={`${tid}-when`}>{formatOccurrence(occurrence.startsAt, m.durationMinutes)}</span>
          </div>
          <div style={row}>
            <span style={label}>繰り返し</span>
            <span style={value} data-testid={`${tid}-recurrence`}>
              {recurrenceLabel(m.recurrence, firstDate)}
              {m.recurrence !== "none" && m.until ? `（${m.until.replace(/-/g, "/")} まで）` : ""}
            </span>
          </div>
          <div style={row}>
            <span style={label}>対象</span>
            <span style={value} data-testid={`${tid}-target`}>{m.targetName}</span>
          </div>
          {m.trackAttendance ? (
            <div style={row}>
              <span style={label}>出席</span>
              <span style={value} data-testid={`${tid}-attendance`}>
                {m.targetId === "all" ? "全体定例" : "チーム定例"}として出席を取っています（Dub から参加すると記録）
              </span>
            </div>
          ) : null}
          {pending ? (
            <div style={row}>
              <span style={label}>参加者</span>
              <span style={value} data-testid={`${tid}-attendees`}>作成中…</span>
            </div>
          ) : (
            // This occurrence's answers (they can differ per occurrence of a series).
            <MeetingAttendees meetingId={m.id} date={m.recurrence === "none" ? undefined : jstParts(occurrence.startsAt)?.date} />
          )}
          {m.description ? (
            <div style={{ ...row, flexDirection: "column", gap: "var(--dub-space-1)" }}>
              <span style={label}>メモ</span>
              <span style={{ ...value, whiteSpace: "pre-wrap" }}>{m.description}</span>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: "var(--dub-space-3)", flexWrap: "wrap", paddingTop: "var(--dub-space-4)" }}>
            {m.meetUrl ? (
              <Button variant="primary" onClick={() => (onJoin ? onJoin(m) : openExternal(m.meetUrl!))} testId={`${tid}-join`}>
                Meet に参加
              </Button>
            ) : (
              <span style={{ ...value, color: "var(--dub-color-text-muted)" }} data-testid={`${tid}-no-meet`}>
                {pending ? "作成中… 完了すると Meet リンクが出ます" : "Meet リンクはまだありません"}
              </span>
            )}
            {m.htmlLink ? (
              <Button variant="secondary" onClick={() => openExternal(m.htmlLink!)} testId={`${tid}-gcal`}>
                Google カレンダーで開く
              </Button>
            ) : null}
          </div>
        </div>
      </Modal>
      <ConfirmDialog
        open={confirming}
        title="ミーティングを削除しますか？"
        message={
          m.recurrence === "none"
            ? `「${m.title}」を削除します。Google カレンダーの予定も削除され、招待されたメンバーに通知されます。`
            : `「${m.title}」をすべての回まとめて削除します。Google カレンダーの予定も削除され、招待されたメンバーに通知されます。`
        }
        confirmLabel="削除する"
        danger
        onConfirm={() => {
          setConfirming(false);
          onDelete(m);
        }}
        onCancel={() => setConfirming(false)}
        testId={`${tid}-confirm`}
      />
    </>
  );
}
