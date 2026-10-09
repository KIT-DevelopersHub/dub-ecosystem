// One task on the board (design §6: 3 information layers — title / target+elapsed /
// latest-output line, nothing more). A card in the 走行中 lane opens its OWN live SSE
// stream (useRunStream) so many runs stream at once — this is what replaces the old
// single-run busy lock (P0-3).
import { useRunStream } from "./lib/useRunStream.ts";
import type { CommanderClient } from "./lib/client.ts";
import type { BoardItem, RunHistoryApi } from "./lib/commanderApi.ts";
import {
  deriveLane,
  isRunningLane,
  LANE_COLORS,
  needsFix,
  NEEDS_FIX_COLOR,
} from "./lib/lanes.ts";
import {
  reflectionOf,
  reflectionLabel,
  REFLECTION_ICON,
  REFLECTION_COLOR,
  type Reflection,
} from "./lib/reflection.ts";
import { ArtifactLinks } from "./ArtifactLinks.tsx";
import { Spinner } from "./Spinner.tsx";
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
  const isRunning = isRunningLane(lane) && !!item.latestRun;
  // A running deploy phase reads as 「反映中」 rather than a generic run, so the operator can
  // see 「stgに進む」 actually kicked work (not just a badge flip).
  const deployingLabel =
    isRunning && item.featurePhase === "staging_deployed"
      ? "staging反映中"
      : isRunning && item.featurePhase === "prod_shipped"
        ? "本番反映中"
        : null;
  // Only running cards subscribe live; others pass null (no socket).
  const stream = useRunStream(isRunning ? item.latestRun!.id : null, { client, history });
  // 要修正は専用列を持たないので、確認列の中でカードを赤くして見分けさせる。
  const fix = needsFix(item);
  const accent = fix ? NEEDS_FIX_COLOR : LANE_COLORS[lane];
  // Reflection cue (requirement #2): on a settled card — especially in 確認待ち — show at a
  // glance whether the deploy is 反映済み / 反映失敗 (with time + URL). A running card keeps
  // its live spinner (deployingLabel/lastLine) instead, so we skip the badge there.
  const reflection = !isRunning ? reflectionOf(item) : null;

  const open = () => onOpen(item.taskId);
  return (
    // A div (not a button) so the inner "中止" button is valid (no nested buttons).
    // Keyboard-operable: Enter/Space open the drawer, matching a button's semantics.
    <div
      role="button"
      tabIndex={0}
      aria-label={`${item.title} を開く`}
      data-testid={`task-card-${item.taskId}`}
      className="cmdr-card"
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
        border: `1px solid ${fix ? NEEDS_FIX_COLOR : t.border}`,
        borderRadius: "var(--dub-radius-sm, 8px)",
        padding: t.space3,
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        opacity: pending ? 0.6 : 1,
        boxSizing: "border-box",
      }}
    >
      {/* layer 1: status icon + target worktree + elapsed（GitHub の「repo #番号」行に相当） */}
      <div style={{ display: "flex", alignItems: "center", gap: t.space2, fontSize: 12, color: t.textMuted }}>
        <StatusIcon color={accent} running={isRunning} fix={fix} />
        <span
          title={item.latestRun?.cwd ?? ""}
          style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {basename(item.latestRun?.cwd ?? "")}
        </span>
        <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{relTime(item.updatedAt)}</span>
      </div>

      {/* layer 2: title */}
      <div
        className="cmdr-card-title"
        style={{ marginTop: t.space1, fontWeight: 600, fontSize: 14, lineHeight: 1.4, overflowWrap: "anywhere" }}
      >
        {item.title}
      </div>

      {/* labels: 要修正 / 反映状況（GitHub のラベル行）。列見出しが状態名を持つので要修正だけ足す。 */}
      {(fix || reflection) && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: t.space1 }}>
          {fix && (
            <span
              data-testid={`task-lane-${item.taskId}`}
              style={{
                marginTop: t.space2,
                fontSize: 11,
                fontWeight: 600,
                color: NEEDS_FIX_COLOR,
                border: `1px solid ${NEEDS_FIX_COLOR}`,
                borderRadius: 999,
                padding: "0 8px",
                lineHeight: "18px",
                whiteSpace: "nowrap",
              }}
            >
              要修正
            </span>
          )}
          {reflection && (
            <ReflectionBadge taskId={item.taskId} reflection={reflection} when={relTime(item.updatedAt)} />
          )}
        </div>
      )}

      {/* artifact links: demo / staging / PR click-throughs (P1-2) */}
      <ArtifactLinks
        urls={{ demoUrl: item.demoUrl, stagingUrl: item.stagingUrl, prUrl: item.prUrl }}
        variant="card"
        phase={item.featurePhase}
      />

      {/* deploy-in-progress banner: makes 「反映中」 explicit on the card */}
      {deployingLabel && (
        <div
          data-testid={`task-deploying-${item.taskId}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: t.space2,
            marginTop: t.space2,
            fontSize: 12,
            fontWeight: 600,
            color: LANE_COLORS.implementing,
          }}
        >
          <Spinner size={12} color={LANE_COLORS.implementing} />
          {deployingLabel}…
        </div>
      )}

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

      {/* 中止は控えめに右下へ（全走行カードに赤ボタンが並ぶと押し間違えやすい）。 */}
      {isRunning && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: t.space2 }}>
          <button
            type="button"
            data-testid={`task-cancel-${item.taskId}`}
            className="cmdr-cancel"
            title="この実行を中止"
            onClick={(e) => {
              e.stopPropagation();
              if (item.latestRun) onCancel(item.latestRun.id);
            }}
            style={{
              fontSize: 12,
              color: t.textMuted,
              background: "transparent",
              border: `1px solid ${t.border}`,
              borderRadius: "var(--dub-radius-sm, 8px)",
              padding: `1px ${t.space2}`,
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

/** GitHub の issue アイコン相当: 走行中は回転、要修正は塗りつぶし、それ以外は輪郭の丸。 */
function StatusIcon({ color, running, fix }: { color: string; running: boolean; fix: boolean }) {
  if (running) return <Spinner size={12} color={color} />;
  return (
    <span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        borderRadius: 999,
        border: `2px solid ${color}`,
        background: fix ? color : "transparent",
        boxSizing: "border-box",
        flexShrink: 0,
      }}
    />
  );
}

/**
 * 反映ステータスのバッジ。確認待ちゾーンで「押した直後のカードが本当に反映されたのか」を
 * 一目で判別できるようにする（requirement #2）。反映済み=✅+反映時刻+URL、反映中=🔄、
 * 反映失敗=⚠️ を色分けで示す。
 */
function ReflectionBadge({
  taskId,
  reflection,
  when,
}: {
  taskId: string;
  reflection: Reflection;
  when: string;
}) {
  const color = REFLECTION_COLOR[reflection.state];
  return (
    <div
      data-testid={`reflection-badge-${taskId}`}
      data-reflection-state={reflection.state}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: t.space2,
        marginTop: t.space2,
        padding: "0 8px",
        lineHeight: "18px",
        borderRadius: 999,
        border: `1px solid ${color}`,
        fontSize: 11,
        fontWeight: 600,
        color,
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
    >
      <span aria-hidden>{REFLECTION_ICON[reflection.state]}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {reflectionLabel(reflection)}
        {reflection.state !== "reflecting" && when ? ` · ${when}` : ""}
      </span>
    </div>
  );
}
