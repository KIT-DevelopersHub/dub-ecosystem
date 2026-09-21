// Task detail (P0-5) + next-action bar (P0-6). Opens from a board card. Tabs:
//   - ログ:        the latest run's log — restored from D1 then live (useRunStream).
//   - フェーズ&監査: the feature's phase, allowed transitions and the immutable audit
//                  log (migrated here from FeatureBoard; the server gate is unchanged).
// Next actions close the judgment loop: 承認 (approval-gated), 却下 (feedback → new run),
// 追加指示 (new run in the same task), 完了 (archive to the Done lane).
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
import { deriveLane, LANE_COLORS, LANE_LABELS } from "./lib/lanes.ts";
import { btnDanger, btnGhost, btnPrimary, input, t } from "./lib/theme.ts";

export interface TaskDrawerHandlers {
  onApprove: (to: FeaturePhase) => Promise<void>;
  onReject: (to: FeaturePhase, feedback: string) => Promise<void>;
  /** Additional instruction / fix re-run: a new run in the same task. */
  onRerun: (prompt: string) => Promise<void>;
  /** Start the first run for a registered-but-unrequested (未依頼) task. */
  onRequestRun?: (prompt: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onCancelRun: (runId: string) => void;
}

interface TaskDrawerProps extends TaskDrawerHandlers {
  item: BoardItem | null;
  api: CommanderApi;
  client: CommanderClient;
  history: RunHistoryApi;
  onClose: () => void;
  /** Prefill for the 未依頼 task's AI依頼 prompt (the text captured at registration). */
  requestPromptDefault?: string;
  /** Bumped by the board after an action to force a detail reload. */
  version: number;
}

type Tab = "log" | "phase";

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
  const { item, api, client, history, onClose, version, requestPromptDefault } = props;
  const [tab, setTab] = useState<Tab>("log");
  const [detail, setDetail] = useState<FeatureDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<FeaturePhase | null>(null);
  const [rejectTo, setRejectTo] = useState<FeaturePhase | null>(null);
  const [feedback, setFeedback] = useState("");
  const [rerunOpen, setRerunOpen] = useState(false);
  const [rerunPrompt, setRerunPrompt] = useState("");
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestPrompt, setRequestPrompt] = useState("");
  const [busy, setBusy] = useState(false);

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
    setRequestOpen(false);
    setRequestPrompt(requestPromptDefault ?? "");
    void loadDetail();
  }, [loadDetail, version, requestPromptDefault]);

  if (!item) return null;
  const lane = deriveLane(item);
  const approvalEdge = detail?.allowedTransitions.find((tr) => tr.requiresApproval) ?? null;
  const rejectEdge =
    detail?.allowedTransitions.find(
      (tr) => tr.to === "demo_rejected" || tr.to === "staging_rejected",
    ) ?? null;

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
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
          style={{ fontSize: 12, fontWeight: 700, color: LANE_COLORS[lane] }}
        >
          {LANE_LABELS[lane]}
        </span>
      }
    >
      {/* tabs */}
      <div role="tablist" style={{ display: "flex", gap: t.space2, marginBottom: t.space4 }}>
        {(["log", "phase"] as Tab[]).map((tb) => (
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
            {tb === "log" ? "ログ" : "フェーズ & 監査"}
          </button>
        ))}
      </div>

      {tab === "log" && (
        <div>
          <div style={{ fontSize: 12, color: t.textMuted, marginBottom: t.space2 }}>
            対象: {item.latestRun?.cwd || "daemon 既定"} ·{" "}
            <span data-testid="drawer-run-status">{stream.status}</span>
            {stream.live && <span style={{ color: LANE_COLORS.running }}> · live</span>}
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
          {lane === "review" && approvalEdge && (
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
          {lane === "review" && rejectEdge && (
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
          {lane === "queued" && props.onRequestRun && (
            <button
              type="button"
              data-testid="action-request-run"
              disabled={busy}
              onClick={() => setRequestOpen((v) => !v)}
              style={btnPrimary}
            >
              🤖 AIに依頼する
            </button>
          )}
          {(lane === "review" || lane === "needs_fix") && (
            <button
              type="button"
              data-testid="action-rerun"
              disabled={busy}
              onClick={() => setRerunOpen((v) => !v)}
              style={btnGhost}
            >
              {lane === "needs_fix" ? "修正して再実行" : "追加指示"}
            </button>
          )}
          {lane === "running" && item.latestRun && (
            <button
              type="button"
              data-testid="action-cancel"
              onClick={() => props.onCancelRun(item.latestRun!.id)}
              style={btnDanger}
            >
              中止
            </button>
          )}
          {lane !== "done" && (
            <button
              type="button"
              data-testid="action-archive"
              disabled={busy}
              onClick={() => void wrap(props.onArchive)}
              style={btnGhost}
            >
              完了（アーカイブ）
            </button>
          )}
        </div>

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
                void wrap(async () => {
                  await props.onApprove(pendingApproval);
                  setPendingApproval(null);
                })
              }
              style={btnPrimary}
            >
              承認して実行
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
                  })
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

        {/* 未依頼 → AIに依頼する: start the first run with the (editable) captured prompt */}
        {requestOpen && props.onRequestRun && (
          <div data-testid="request-run-form" style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
            <textarea
              aria-label="request-prompt"
              placeholder="AI に渡す指示（登録時の文章。ここで調整できます）"
              value={requestPrompt}
              onChange={(e) => setRequestPrompt(e.target.value)}
              style={{ ...input, minHeight: 80, resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: t.space2 }}>
              <button
                type="button"
                data-testid="request-run-submit"
                disabled={busy || requestPrompt.trim() === ""}
                onClick={() =>
                  void wrap(async () => {
                    await props.onRequestRun!(requestPrompt.trim());
                    setRequestOpen(false);
                  })
                }
                style={{ ...btnPrimary, opacity: requestPrompt.trim() === "" ? 0.5 : 1 }}
              >
                この指示で実行する
              </button>
              <button type="button" onClick={() => setRequestOpen(false)} style={btnGhost}>
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
                  })
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
