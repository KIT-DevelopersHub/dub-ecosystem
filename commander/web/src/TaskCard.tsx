// One task on the board (design §6: 3 information layers — title / target+elapsed /
// latest-output line, nothing more). A card in the 走行中 lane opens its OWN live SSE
// stream (useRunStream) so many runs stream at once — this is what replaces the old
// single-run busy lock (P0-3).
import { useRunStream } from "./lib/useRunStream.ts";
import type { CommanderClient } from "./lib/client.ts";
import type { BoardItem, RunHistoryApi } from "./lib/commanderApi.ts";
import { deriveLane, LANE_COLORS, LANE_LABELS } from "./lib/lanes.ts";
import { ArtifactLinks } from "./ArtifactLinks.tsx";
import { t } from "./lib/theme.ts";

interface TaskCardProps {
  item: BoardItem;
  client: CommanderClient;
  history: RunHistoryApi;
  onOpen: (taskId: string) => void;
  onCancel: (runId: string) => void;
  /** True for an optimistic card whose run hasn't been confirmed by the server yet. */
  pending?: boolean;
}

function basename(p: string): string {
  if (!p) return "daemon 既定";
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.round(m / 60)}時間前`;
}

export function TaskCard({ item, client, history, onOpen, onCancel, pending }: TaskCardProps) {
  const lane = deriveLane(item);
  const isRunning = lane === "running" && !!item.latestRun;
  // Only running cards subscribe live; others pass null (no socket).
  const stream = useRunStream(isRunning ? item.latestRun!.id : null, { client, history });
  const accent = LANE_COLORS[lane];

  const open = () => onOpen(item.taskId);
  return (
    // A div (not a button) so the inner "中止" button is valid (no nested buttons).
    // Keyboard-operable: Enter/Space open the drawer, matching a button's semantics.
    <div
      role="button"
      tabIndex={0}
      aria-label={`${item.title} を開く`}
      data-testid={`task-card-${item.taskId}`}
      onClick={open}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          open();
        }
      }}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: t.radius,
        padding: t.space3,
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        opacity: pending ? 0.6 : 1,
        boxSizing: "border-box",
      }}
    >
      {/* layer 1: title + lane */}
      <div style={{ display: "flex", alignItems: "baseline", gap: t.space2 }}>
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1, overflowWrap: "anywhere" }}>
          {item.title}
        </span>
        <span
          data-testid={`task-lane-${item.taskId}`}
          style={{ fontSize: 11, fontWeight: 700, color: accent, whiteSpace: "nowrap" }}
        >
          {LANE_LABELS[lane]}
        </span>
      </div>

      {/* layer 2: target worktree + elapsed */}
      <div style={{ display: "flex", gap: t.space2, marginTop: t.space2, fontSize: 12, color: t.textMuted }}>
        <span title={item.latestRun?.cwd ?? ""} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          📁 {basename(item.latestRun?.cwd ?? "")}
        </span>
        <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{relTime(item.updatedAt)}</span>
      </div>

      {/* artifact links: demo / staging / PR click-throughs (P1-2) */}
      <ArtifactLinks
        urls={{ demoUrl: item.demoUrl, stagingUrl: item.stagingUrl, prUrl: item.prUrl }}
        variant="card"
      />

      {/* layer 3: latest live output (running only) */}
      {isRunning && stream.lastLine && (
        <div
          data-testid={`task-lastline-${item.taskId}`}
          style={{
            marginTop: t.space2,
            fontSize: 12,
            color: t.text,
            fontFamily: "var(--dub-font-family-mono, ui-monospace, monospace)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            opacity: 0.85,
          }}
        >
          {stream.lastLine}
        </div>
      )}

      {isRunning && (
        <div style={{ marginTop: t.space3 }}>
          <button
            type="button"
            data-testid={`task-cancel-${item.taskId}`}
            onClick={(e) => {
              e.stopPropagation();
              if (item.latestRun) onCancel(item.latestRun.id);
            }}
            style={{
              fontSize: 12,
              color: t.danger,
              background: "transparent",
              border: `1px solid ${t.border}`,
              borderRadius: "var(--dub-radius-sm, 8px)",
              padding: `2px ${t.space2}`,
              cursor: "pointer",
              font: "inherit",
            }}
          >
            中止
          </button>
        </div>
      )}
    </div>
  );
}
