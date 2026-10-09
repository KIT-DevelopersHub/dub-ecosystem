// Task detail (P0-5) + next-action bar (P0-6). Opens from a board card. Tabs:
//   - ログ:        the latest run's log — restored from D1 then live (useRunStream).
//   - フェーズ&監査: the feature's phase, allowed transitions and the immutable audit
//                  log (migrated here from FeatureBoard; the server gate is unchanged).
// Next actions close the judgment loop: 承認 (approval-gated), 却下 (feedback → new run),
// 追加指示 (new run in the same task, phase unchanged), フェーズを戻す (phase-only step
// back to a 確認待ち), 完了 (archive to the Done lane).
import { useCallback, useEffect, useState } from "react";
import { Drawer } from "./Drawer.tsx";
import type { CommanderClient } from "./lib/client.ts";
import {
  PHASE_LABELS,
  type ApiError,
  type CommanderApi,
  type BoardItem,
  type FeatureDetail,
  type FeaturePhase,
  type RunHistoryApi,
} from "./lib/commanderApi.ts";
import { useRunStream } from "./lib/useRunStream.ts";
import {
  deriveLane,
  isArchived,
  isReviewLane,
  isRunningLane,
  LANE_COLORS,
  LANE_LABELS,
  needsFix,
  NEEDS_FIX_COLOR,
} from "./lib/lanes.ts";
import {
  reflectionOf,
  reflectionLabel,
  REFLECTION_ICON,
  REFLECTION_COLOR,
} from "./lib/reflection.ts";
import { ArtifactLinks } from "./ArtifactLinks.tsx";
import { Spinner, ProgressBar } from "./Spinner.tsx";
import { btnDanger, btnGhost, btnPrimary, input, t } from "./lib/theme.ts";

/** Human copy for the in-flight banner shown while an action is processing. */
function inFlightLabel(kind: InFlight, to: FeaturePhase | null): string {
  if (kind === "approve") {
    if (to === "staging_deployed") return "staging に反映中… 完了すると『確認待ち』に移ります";
    if (to === "prod_shipped") return "本番に反映中… 完了すると『本番確認中』に移ります";
    return "反映中…";
  }
  if (kind === "reject") return "却下を記録し、修正 run を起動中…";
  if (kind === "rerun") return "指示を送って新しい run を起動中…";
  if (kind === "rewind") return "フェーズを戻しています…";
  if (kind === "archive") return "アーカイブ中…";
  return "処理中…";
}

type InFlight = "approve" | "reject" | "rerun" | "rewind" | "archive" | null;

export interface TaskDrawerHandlers {
  onApprove: (to: FeaturePhase) => Promise<void>;
  onReject: (to: FeaturePhase, feedback: string) => Promise<void>;
  /** Additional instruction / fix re-run: a new run in the same task. */
  onRerun: (prompt: string) => Promise<void>;
  /** Phase-only step back to an earlier 確認待ち phase (no run, no rollback). */
  onRewind: (to: FeaturePhase) => Promise<void>;
  onArchive: () => Promise<void>;
  onCancelRun: (runId: string) => void;
}

interface TaskDrawerProps extends TaskDrawerHandlers {
  item: BoardItem | null;
  api: CommanderApi;
  client: CommanderClient;
  history: RunHistoryApi;
  onClose: () => void;
  /** Bumped by the board after an action to force a detail reload. */
  version: number;
}

type Tab = "log" | "artifact" | "phase";

/** "https://github.com/o/r/pull/564" -> "#564" (full URL stays in the tooltip). */
export function prLabel(url: string): string {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? `#${m[1]}` : url;
}

function errorMessage(e: ApiError): string {
  switch (e.error) {
    case "illegal_transition":
      return `段飛ばし禁止: この遷移は許可されていません (${e.status})`;
    case "approval_required":
      return `自己承認禁止: ユーザーの明示承認が必要です (${e.status})`;
    default:
      return `${e.error}${e.message ? `: ${e.message}` : ""} (${e.status})`;
  }
}

export function TaskDrawer(props: TaskDrawerProps) {
  const { item, api, client, history, onClose, version } = props;
  const [tab, setTab] = useState<Tab>("log");
  const [detail, setDetail] = useState<FeatureDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<FeaturePhase | null>(null);
  const [rejectTo, setRejectTo] = useState<FeaturePhase | null>(null);
  const [feedback, setFeedback] = useState("");
  const [rerunOpen, setRerunOpen] = useState(false);
  const [rerunPrompt, setRerunPrompt] = useState("");
  const [rewindOpen, setRewindOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Which action is currently processing (drives the visible 「反映中…」 banner). `busy`
  // alone only disabled buttons — the operator saw nothing happen (「動いてる?」). This
  // makes the in-flight state explicit until the server round-trip + run kick resolve.
  const [inFlight, setInFlight] = useState<InFlight>(null);
  const [inFlightTo, setInFlightTo] = useState<FeaturePhase | null>(null);

  const stream = useRunStream(item?.latestRun ? item.latestRun.id : null, { client, history });

  const featureId = item?.featureId ?? null;
  const loadDetail = useCallback(async () => {
    if (!featureId) return;
    setDetailLoading(true);
    try {
      setDetail(await api.getFeature(featureId));
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [api, featureId]);

  useEffect(() => {
    setTab("log");
    setPendingApproval(null);
    setRejectTo(null);
    setFeedback("");
    setRerunOpen(false);
    setRerunPrompt("");
    setRewindOpen(false);
    void loadDetail();
  }, [loadDetail, version]);

  if (!item) return null;
  const lane = deriveLane(item);
  const running = isRunningLane(lane);
  const fix = needsFix(item);
  const reviewable = isReviewLane(lane) && !fix;
  // 「もう触らない」の唯一の判定はユーザーの明示アーカイブ。本番反映済(prod_shipped)は
  // まだ生きているタスクなので、不備が見つかったら追加指示で直せる状態に保つ。
  const archived = isArchived(item);
  const reflection = reflectionOf(item);
  const approvalEdge = detail?.allowedTransitions.find((tr) => tr.requiresApproval) ?? null;
  const rejectEdge =
    detail?.allowedTransitions.find(
      (tr) => tr.to === "demo_rejected" || tr.to === "staging_rejected",
    ) ?? null;
  const rewindEdges = detail?.allowedTransitions.filter((tr) => tr.rewind) ?? [];

  const wrap = async (
    fn: () => Promise<void>,
    kind: InFlight = null,
    to: FeaturePhase | null = null,
  ) => {
    setBusy(true);
    setInFlight(kind);
    setInFlightTo(to);
    try {
      await fn();
    } finally {
      setBusy(false);
      setInFlight(null);
      setInFlightTo(null);
    }
  };

  return (
    <Drawer
      open={!!item}
      onClose={onClose}
      title={item.title}
      testId="task-drawer"
      headerExtra={
        <span
          data-testid="drawer-lane"
          style={{ fontSize: 12, fontWeight: 700, color: fix ? NEEDS_FIX_COLOR : LANE_COLORS[lane] }}
        >
          {LANE_LABELS[lane]}
          {fix && "（要修正）"}
        </span>
      }
    >
      {/* reflection banner: 反映済み(✅+URL) / 反映中(🔄 spinner) / 反映失敗(⚠️) を最上部で明示。
          確認待ちで「反映が終わったのか進行中か」を即判別でき、本番反映中の進行表示も兼ねる。 */}
      {reflection && (
        <div
          data-testid="drawer-reflection"
          data-reflection-state={reflection.state}
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: t.space2,
            marginBottom: t.space4,
            padding: t.space3,
            borderRadius: t.radius,
            border: `1px solid ${REFLECTION_COLOR[reflection.state]}`,
            fontSize: 13,
            fontWeight: 600,
            color: REFLECTION_COLOR[reflection.state],
          }}
        >
          {reflection.state === "reflecting" ? (
            <Spinner size={13} color={REFLECTION_COLOR[reflection.state]} />
          ) : (
            <span aria-hidden>{REFLECTION_ICON[reflection.state]}</span>
          )}
          <span>{reflectionLabel(reflection)}</span>
          {reflection.state === "reflected" && reflection.url && (
            <a
              href={reflection.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: "auto", color: REFLECTION_COLOR[reflection.state], fontSize: 12 }}
            >
              確認する ↗
            </a>
          )}
        </div>
      )}

      {/* PR links: every PR this task produced, visible as soon as the drawer opens. */}
      <div
        data-testid="drawer-prs"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: t.space2,
          marginBottom: t.space4,
          fontSize: 13,
        }}
      >
        <span style={{ fontWeight: 700, color: t.textMuted }}>PR</span>
        {item.prUrls.length === 0 ? (
          <span style={{ color: t.textMuted }}>まだありません</span>
        ) : (
          item.prUrls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={url}
              data-testid="drawer-pr-link"
              style={{
                padding: `2px ${t.space2}`,
                borderRadius: t.radius,
                border: `1px solid ${t.border}`,
                color: t.text,
                textDecoration: "none",
              }}
            >
              {prLabel(url)} ↗
            </a>
          ))
        )}
      </div>

      {/* tabs */}
      <div role="tablist" style={{ display: "flex", gap: t.space2, marginBottom: t.space4 }}>
        {(["log", "artifact", "phase"] as Tab[]).map((tb) => (
          <button
            key={tb}
            type="button"
            role="tab"
            aria-selected={tab === tb}
            data-testid={`tab-${tb}`}
            onClick={() => setTab(tb)}
            style={{
              ...btnGhost,
              background: tab === tb ? t.surface : "transparent",
              borderColor: tab === tb ? t.borderStrong : t.border,
            }}
          >
            {tb === "log" ? "ログ" : tb === "artifact" ? "成果物" : "フェーズ & 監査"}
          </button>
        ))}
      </div>

      {tab === "log" && (
        <div>
          <div style={{ fontSize: 12, color: t.textMuted, marginBottom: t.space2 }}>
            対象: {item.latestRun?.cwd || "daemon 既定"} ·{" "}
            <span data-testid="drawer-run-status">{stream.status}</span>
            {stream.live && <span style={{ color: LANE_COLORS.implementing }}> · live</span>}
          </div>
          <pre
            data-testid="drawer-log"
            style={{
              margin: 0,
              padding: t.space3,
              borderRadius: t.radius,
              border: `1px solid ${t.border}`,
              background: t.sunken,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: "48vh",
              overflow: "auto",
              fontSize: 12,
            }}
          >
            {stream.log.length === 0 ? "（ログはまだありません）" : stream.log.join("\n")}
          </pre>
        </div>
      )}

      {tab === "artifact" && (
        <div data-testid="drawer-artifact">
          <div style={{ fontSize: 12, color: t.textMuted, marginBottom: t.space3 }}>
            この実行の成果物。クリックして demo / staging / PR を確認できます。
          </div>
          <ArtifactLinks
            urls={{ demoUrl: item.demoUrl, stagingUrl: item.stagingUrl, prUrl: item.prUrls.at(-1) ?? item.prUrl }}
            variant="drawer"
            phase={item.featurePhase}
            running={running}
          />
        </div>
      )}

      {tab === "phase" && (
        <div data-testid="drawer-phase">
          {detailLoading && !detail ? (
            <div style={{ height: 60, borderRadius: t.radius, background: t.surface, opacity: 0.5 }} />
          ) : !detail ? (
            <div style={{ fontSize: 13, color: t.textMuted }}>
              フェーズ情報を取得できませんでした（service 未起動の可能性）。
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, marginBottom: t.space3 }}>
                現在フェーズ: <strong>{PHASE_LABELS[detail.feature.phase]}</strong>
              </div>
              <div style={{ fontSize: 12, color: t.textMuted, marginBottom: t.space2 }}>遷移履歴（監査ログ）</div>
              <ol data-testid="drawer-audit" style={{ fontSize: 13, paddingLeft: 18, margin: 0 }}>
                {detail.transitions.length === 0 && (
                  <li style={{ color: t.textMuted, listStyle: "none", marginLeft: -18 }}>まだ遷移はありません</li>
                )}
                {detail.transitions.map((tx) => (
                  <li key={tx.id}>
                    {PHASE_LABELS[tx.fromPhase]} → {PHASE_LABELS[tx.toPhase]}{" "}
                    <span style={{ opacity: 0.7 }}>
                      [{tx.actor}
                      {tx.approvedByUser ? " / 承認あり" : ""}]
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}

      {/* ── Next-action bar (P0-6) ─────────────────────────────────────────── */}
      <div
        data-testid="next-action-bar"
        style={{
          marginTop: t.space6,
          paddingTop: t.space4,
          borderTop: `1px solid ${t.border}`,
          display: "flex",
          flexDirection: "column",
          gap: t.space3,
        }}
      >
        <div style={{ display: "flex", gap: t.space3, flexWrap: "wrap" }}>
          {reviewable && approvalEdge && (
            <button
              type="button"
              data-testid="action-approve"
              disabled={busy}
              onClick={() => setPendingApproval(approvalEdge.to)}
              style={{ ...btnPrimary, background: t.warning }}
            >
              🔒 承認して次へ（{PHASE_LABELS[approvalEdge.to]}）
            </button>
          )}
          {reviewable && rejectEdge && (
            <button
              type="button"
              data-testid="action-reject"
              disabled={busy}
              onClick={() => setRejectTo(rejectEdge.to)}
              style={btnDanger}
            >
              却下（要修正・再投げ）
            </button>
          )}
          {!running && !archived && (
            <button
              type="button"
              data-testid="action-rerun"
              disabled={busy}
              onClick={() => setRerunOpen((v) => !v)}
              style={btnGhost}
            >
              {fix ? "修正して再実行" : "追加指示"}
            </button>
          )}
          {!running && !archived && rewindEdges.length > 0 && (
            <button
              type="button"
              data-testid="action-rewind"
              disabled={busy}
              onClick={() => setRewindOpen((v) => !v)}
              style={btnGhost}
            >
              フェーズを戻す
            </button>
          )}
          {running && item.latestRun && (
            <button
              type="button"
              data-testid="action-cancel"
              onClick={() => props.onCancelRun(item.latestRun!.id)}
              style={btnDanger}
            >
              中止
            </button>
          )}
          {!archived && (
            <button
              type="button"
              data-testid="action-archive"
              disabled={busy}
              onClick={() => void wrap(props.onArchive, "archive")}
              style={btnGhost}
            >
              完了（アーカイブ）
            </button>
          )}
        </div>

        {/* in-flight banner: makes 「反映中…」 visible (the 「動いてる?」 fix). */}
        {inFlight && (
          <div
            data-testid="action-inflight"
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: t.space2,
              padding: t.space3,
              borderRadius: t.radius,
              border: `1px solid ${t.warning}`,
              background: t.surface,
              fontSize: 13,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: t.space2 }}>
              <Spinner />
              <span>{inFlightLabel(inFlight, inFlightTo)}</span>
            </div>
            <ProgressBar />
          </div>
        )}

        {/* approval confirm (🔒 self-approval guard) */}
        {pendingApproval && (
          <div
            data-testid="approval-confirm"
            style={{
              padding: t.space3,
              borderRadius: t.radius,
              border: `1px solid ${t.warning}`,
              fontSize: 13,
            }}
          >
            <div style={{ marginBottom: t.space2 }}>
              ⚠「{PHASE_LABELS[pendingApproval]}」への遷移は<strong>ユーザー承認が必須</strong>です。承認して進めますか？
            </div>
            <button
              type="button"
              data-testid="approval-confirm-yes"
              disabled={busy}
              onClick={() =>
                void wrap(
                  async () => {
                    await props.onApprove(pendingApproval);
                    setPendingApproval(null);
                  },
                  "approve",
                  pendingApproval,
                )
              }
              style={{ ...btnPrimary, display: "inline-flex", alignItems: "center", gap: t.space2 }}
            >
              {busy && inFlight === "approve" && <Spinner size={12} color="#fff" />}
              {busy && inFlight === "approve" ? "反映中…" : "承認して実行"}
            </button>
            <button type="button" onClick={() => setPendingApproval(null)} style={{ ...btnGhost, marginLeft: t.space2 }}>
              キャンセル
            </button>
          </div>
        )}

        {/* reject feedback → re-run */}
        {rejectTo && (
          <div data-testid="reject-form" style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
            <textarea
              aria-label="reject-feedback"
              placeholder="却下の理由・直してほしい点（次の実行の指示に添えられます）"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              style={{ ...input, minHeight: 80, resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: t.space2 }}>
              <button
                type="button"
                data-testid="reject-submit"
                disabled={busy || feedback.trim() === ""}
                onClick={() =>
                  void wrap(async () => {
                    await props.onReject(rejectTo, feedback.trim());
                    setRejectTo(null);
                    setFeedback("");
                  }, "reject")
                }
                style={{ ...btnDanger, opacity: feedback.trim() === "" ? 0.5 : 1 }}
              >
                却下して再投げ
              </button>
              <button type="button" onClick={() => setRejectTo(null)} style={btnGhost}>
                やめる
              </button>
            </div>
          </div>
        )}

        {/* phase rewind: pick an earlier 確認待ち phase */}
        {rewindOpen && rewindEdges.length > 0 && (
          <div
            data-testid="rewind-form"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: t.space3,
              padding: t.space3,
              borderRadius: t.radius,
              border: `1px solid ${t.border}`,
              background: t.surface,
              fontSize: 13,
            }}
          >
            <div style={{ lineHeight: 1.6 }}>
              現在「<strong>{PHASE_LABELS[item.featurePhase]}</strong>」です。戻す先を選んでください。
              <div style={{ fontSize: 12, color: t.textMuted }}>
                フェーズ表示だけを戻します。反映済みの demo / staging / 本番は巻き戻りません。
              </div>
            </div>
            <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
              {rewindEdges.map((tr) => (
                <button
                  key={tr.to}
                  type="button"
                  data-testid={`rewind-to-${tr.to}`}
                  disabled={busy}
                  onClick={() =>
                    void wrap(async () => {
                      await props.onRewind(tr.to);
                      setRewindOpen(false);
                    }, "rewind")
                  }
                  style={btnGhost}
                >
                  「{PHASE_LABELS[tr.to]}」に戻す
                </button>
              ))}
              <button type="button" onClick={() => setRewindOpen(false)} style={btnGhost}>
                やめる
              </button>
            </div>
          </div>
        )}

        {/* additional instruction / fix re-run */}
        {rerunOpen && (
          <div data-testid="rerun-form" style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
            <textarea
              aria-label="rerun-prompt"
              placeholder="追加の指示 / 直してほしい点を書く（同じタスクで新しい run を起動）"
              value={rerunPrompt}
              onChange={(e) => setRerunPrompt(e.target.value)}
              style={{ ...input, minHeight: 80, resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: t.space2 }}>
              <button
                type="button"
                data-testid="rerun-submit"
                disabled={busy || rerunPrompt.trim() === ""}
                onClick={() =>
                  void wrap(async () => {
                    await props.onRerun(rerunPrompt.trim());
                    setRerunOpen(false);
                    setRerunPrompt("");
                  }, "rerun")
                }
                style={{ ...btnPrimary, opacity: rerunPrompt.trim() === "" ? 0.5 : 1 }}
              >
                この指示で実行
              </button>
              <button type="button" onClick={() => setRerunOpen(false)} style={btnGhost}>
                やめる
              </button>
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}
