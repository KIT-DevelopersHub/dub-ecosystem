// Task detail popover shown when a calendar chip is clicked. Read-only summary +
// a deep link into the マイタスク app (FE4) for editing — the calendar is a VIEW,
// edits stay owned by the task app (single write surface over the shared data).
import { Modal, Badge, Button } from "@dub/ui";
import type { BadgeTone } from "@dub/ui";
import type { task } from "@dub/types";
import { statusVisual } from "./taskVisuals";

const STATUS_TONE: Record<task.TaskStatus, BadgeTone> = {
  todo: "neutral",
  in_progress: "brand",
  blocked: "warning",
  done: "success",
  cancelled: "neutral",
};

const PRIORITY_LABEL: Record<task.TaskPriority, string> = {
  low: "低",
  medium: "中",
  high: "高",
  urgent: "緊急",
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

const row = { display: "flex", gap: "var(--dub-space-3)", padding: "var(--dub-space-1) 0" } as const;
const label = { color: "var(--dub-color-text-muted)", minWidth: "5rem", fontSize: "var(--dub-font-size-sm)" } as const;
const value = { color: "var(--dub-color-text-primary)", fontSize: "var(--dub-font-size-sm)" } as const;

export function TaskDetailDialog({
  task: t,
  onClose,
  onOpenInTasks,
}: {
  task: task.Task | null;
  onClose: () => void;
  onOpenInTasks: (t: task.Task) => void;
}): JSX.Element | null {
  if (!t) return null;
  const v = statusVisual(t.status);
  return (
    <Modal
      open
      onClose={onClose}
      title={t.title}
      size="sm"
      testId="calendar-task-detail"
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--dub-space-2)" }}>
          <Button variant="ghost" onClick={onClose}>
            閉じる
          </Button>
          <Button variant="primary" onClick={() => onOpenInTasks(t)} testId="calendar-open-in-tasks">
            マイタスクで開く
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--dub-space-1)" }}>
        <div style={row}>
          <span style={label}>状態</span>
          <span style={value}>
            <Badge tone={STATUS_TONE[t.status]}>{v.label}</Badge>
          </span>
        </div>
        <div style={row}>
          <span style={label}>優先度</span>
          <span style={value}>{PRIORITY_LABEL[t.priority]}</span>
        </div>
        <div style={row}>
          <span style={label}>期間</span>
          <span style={value}>
            {fmtDate(t.startAt)} 〜 {fmtDate(t.dueAt)}
          </span>
        </div>
        {t.description && (
          <div style={{ ...row, flexDirection: "column", gap: "var(--dub-space-1)" }}>
            <span style={label}>説明</span>
            <span style={{ ...value, whiteSpace: "pre-wrap" }}>{t.description}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
