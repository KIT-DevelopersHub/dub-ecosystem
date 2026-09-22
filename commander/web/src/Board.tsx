// The Commander board — the app's home (design §3). One screen that closes the whole
// judgment loop: 投入(composer) → 走行(lanes, live) → 確認/判断(drawer) → close. It
// composes the two existing truths (run status from the daemon, feature phase from the
// FSM) into task cards bucketed by lane, and orchestrates the phase transitions + run
// starts that move a task between lanes. No single busy lock: many runs proceed at once
// (P0-3), each running card streams on its own (TaskCard/useRunStream).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpCommanderClient, type CommanderClient } from "./lib/client.ts";
import {
  HttpCommanderApi,
  type BoardItem,
  type CommanderApi,
  type FeaturePhase,
} from "./lib/commanderApi.ts";
import { groupByLane, LANES, LANE_COLORS, LANE_LABELS } from "./lib/lanes.ts";
import { TaskCard } from "./TaskCard.tsx";
import { TaskComposer, type ComposerSubmit } from "./TaskComposer.tsx";
import { TaskDrawer } from "./TaskDrawer.tsx";
import { btnGhost, btnPrimary, t } from "./lib/theme.ts";

interface BoardProps {
  client?: CommanderClient;
  api?: CommanderApi;
  /** Board poll interval (ms). 0 disables polling (used in tests). */
  pollMs?: number;
  /** Soft concurrency guidance shown in the status bar (design §7: default 3). */
  concurrencyLimit?: number;
  /** Extra pinned worktree paths for the composer (e.g. the self-brushup pin). */
  cwdPins?: string[];
}

const defaultClient = new HttpCommanderClient();
const defaultApi = new HttpCommanderApi();

/** Compose prior run context into a follow-up prompt (P0 re-injection; P1 = --resume). */
function composePrompt(prior: string | null, addition: string): string {
  if (!prior) return addition;
  return `${prior}\n\n---\n[前回の実行へのフィードバック / 追加指示]\n${addition}`;
}

// Instruction the staging反映 run carries when the user approves demo → staging. This is
// what makes 「stgに進む」 do real work (not just flip the phase): the daemon spawns a run
// in the task's worktree that merges the demo-approved版そのもの into staging and deploys,
// and its live progress is what the board shows as 「staging反映中…」 until it succeeds
// (→ 確認待ち via reconcilePhases) or fails (→ 要修正).
export const STAGING_DEPLOY_PROMPT =
  "[commander] このタスクの demo で承認された版そのものを staging に反映してください。" +
  "手順: (1) demo承認版を staging 統合ブランチにマージ (別物を混ぜない・diff照合)、" +
  "(2) `pnpm deploy:staging` で staging に反映、" +
  "(3) `pnpm verify:live staging \"<マーカー>\"` で配信物にマーカーが実在することを実測、" +
  "(4) 完了したら staging URL を1行で出力。反映が確認できるまで完了扱いにしないでください。";

// Instruction the本番反映 run carries when the user approves staging → prod. Mirrors the
// staging反映 run so 本番承認 も同じ進行UI（本番反映中 → 完了/失敗）に繋がる: the daemon
// spawns a real run that ships the staging-approved版そのもの to 本番, and its live progress
// is what the board shows as 「本番反映中」 until it succeeds (→完了) or fails (→要修正).
export const PROD_DEPLOY_PROMPT =
  "[commander] このタスクの staging で承認された版そのものを本番に反映してください。" +
  "手順: (1) staging承認版を main にマージ (別物を混ぜない・diff照合)、" +
  "(2) `pnpm deploy` で本番に反映、" +
  "(3) `pnpm verify:live prod \"<マーカー>\"` で配信物にマーカーが実在することを実測、" +
  "(4) 完了したら本番 URL を1行で出力。反映が確認できるまで完了扱いにしないでください。";

export function Board({
  client = defaultClient,
  api = defaultApi,
  pollMs = 3000,
  concurrencyLimit = 3,
  cwdPins = [],
}: BoardProps) {
  const [items, setItems] = useState<BoardItem[]>([]);
  const [optimistic, setOptimistic] = useState<BoardItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [health, setHealth] = useState<{ daemon: boolean | null; service: boolean | null }>({
    daemon: null,
    service: null,
  });
  const [composerOpen, setComposerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [drawerVersion, setDrawerVersion] = useState(0);
  const reconcilingRef = useRef(false);
  // Feature ids whose staging反映 run was just kicked but whose new (pending) run may not
  // be visible on the board yet. While a feature sits here, reconcilePhases must NOT
  // auto-advance staging_deployed→staging_review off the *stale* (succeeded demo) run —
  // otherwise 「反映中」 would be skipped and the card would jump straight to 確認待ち.
  const deployingRef = useRef<Set<string>>(new Set());

  // Auto-advance deploy-complete markers (non-approval system edges) so a succeeded run
  // lands in 確認待ち. demo_building→demo_review, staging_deployed→staging_review.
  const reconcilePhases = useCallback(
    async (list: BoardItem[]): Promise<boolean> => {
      if (reconcilingRef.current) return false;
      const pending = list.filter(
        (i) =>
          i.latestRun?.status === "succeeded" &&
          (i.featurePhase === "demo_building" || i.featurePhase === "staging_deployed") &&
          // Don't advance off the stale demo run while its staging反映 run is still landing.
          !deployingRef.current.has(i.featureId),
      );
      if (pending.length === 0) return false;
      reconcilingRef.current = true;
      try {
        for (const i of pending) {
          const to: FeaturePhase =
            i.featurePhase === "demo_building" ? "demo_review" : "staging_review";
          await api.transition(i.featureId, to, { approvedByUser: false });
        }
      } finally {
        reconcilingRef.current = false;
      }
      return true;
    },
    [api],
  );

  const load = useCallback(async () => {
    try {
      const list = await api.listBoard();
      // Once a feature's freshly-kicked staging反映 run is visible (pending/running), stop
      // shielding it — the run's own status now governs (running=反映中, succeeded=確認待ち).
      for (const i of list) {
        if (
          deployingRef.current.has(i.featureId) &&
          (i.latestRun?.status === "pending" || i.latestRun?.status === "running")
        ) {
          deployingRef.current.delete(i.featureId);
        }
      }
      const advanced = await reconcilePhases(list);
      const fresh = advanced ? await api.listBoard() : list;
      setItems(fresh);
      // Drop optimistic placeholders that now exist for real (same title still building).
      setOptimistic((prev) => prev.filter((o) => !fresh.some((f) => f.title === o.title)));
    } catch {
      setItems([]); // service down → empty (not broken) board
    } finally {
      setLoaded(true);
    }
  }, [api, reconcilePhases]);

  const probeHealth = useCallback(async () => {
    const [daemon, service] = await Promise.all([
      client.health().catch(() => false),
      api.health().catch(() => false),
    ]);
    setHealth({ daemon, service });
  }, [client, api]);

  useEffect(() => {
    void load();
    void probeHealth();
    if (pollMs > 0) {
      const id = setInterval(() => {
        void load();
        void probeHealth();
      }, pollMs);
      return () => clearInterval(id);
    }
    return undefined;
  }, [load, probeHealth, pollMs]);

  const all = useMemo(() => [...optimistic, ...items], [optimistic, items]);
  const lanes = useMemo(() => groupByLane(all), [all]);
  const runningCount = lanes.running.length;

  const cwdSuggestions = useMemo(() => {
    const fromItems = items.map((i) => i.latestRun?.cwd).filter((c): c is string => !!c);
    return [...new Set([...cwdPins, ...fromItems])];
  }, [items, cwdPins]);

  const selected = all.find((i) => i.taskId === selectedTaskId) ?? null;

  const refreshAfterAction = useCallback(async () => {
    await load();
    setDrawerVersion((v) => v + 1);
  }, [load]);

  // ── Composer: create the work unit, then start its first run ──────────────
  const handleSubmit = useCallback(
    async (v: ComposerSubmit) => {
      setSubmitting(true);
      const placeholder: BoardItem = {
        taskId: `optimistic-${Date.now()}`,
        featureId: "",
        title: v.title,
        featurePhase: "demo_building",
        taskStatus: "todo",
        demoUrl: null,
        stagingUrl: null,
        prUrl: null,
        latestRun: { id: "", status: "pending", cwd: v.cwd, createdAt: new Date().toISOString() },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setOptimistic((prev) => [placeholder, ...prev]);
      setComposerOpen(false);
      try {
        const res = await api.createTask({ title: v.title, ledgerRef: v.ledgerRef || undefined });
        if (!res.ok) {
          setOptimistic((prev) => prev.filter((o) => o.taskId !== placeholder.taskId));
          return;
        }
        await client.startRun(v.prompt, {
          taskId: res.value.task.id,
          ...(v.cwd ? { cwd: v.cwd } : {}),
        });
        await load();
      } catch {
        setOptimistic((prev) => prev.filter((o) => o.taskId !== placeholder.taskId));
      } finally {
        setSubmitting(false);
      }
    },
    [api, client, load],
  );

  // ── Next-action orchestration (P0-6) ──────────────────────────────────────
  const priorPrompt = useCallback(
    async (runId: string | undefined): Promise<string | null> => {
      if (!runId) return null;
      try {
        const detail = await api.getRun(runId);
        return detail?.run.prompt ?? null;
      } catch {
        return null;
      }
    },
    [api],
  );

  const startFollowUpRun = useCallback(
    async (item: BoardItem, addition: string) => {
      const prior = await priorPrompt(item.latestRun?.id);
      await client.startRun(composePrompt(prior, addition), {
        taskId: item.taskId,
        ...(item.latestRun?.cwd ? { cwd: item.latestRun.cwd } : {}),
      });
    },
    [client, priorPrompt],
  );

  const handleApprove = useCallback(
    async (to: FeaturePhase) => {
      if (!selected) return;
      const cwdOpt = selected.latestRun?.cwd ? { cwd: selected.latestRun.cwd } : {};

      if (to === "staging_deployed") {
        // demo承認→staging_deployed: kick a REAL staging反映 run (not just a phase flip). The
        // card then sits in 走行中 streaming live progress = 「反映中」; reconcilePhases moves it
        // to staging_review only when that run SUCCEEDS (failure → 要修正). Shield it meanwhile
        // so the stale demo run doesn't auto-advance it past 反映中.
        await api.transition(selected.featureId, to, { approvedByUser: true });
        deployingRef.current.add(selected.featureId);
        try {
          await client.startRun(STAGING_DEPLOY_PROMPT, { taskId: selected.taskId, ...cwdOpt });
        } catch {
          // daemon down: can't run the reflect now. Fall back to the phase-only advance so
          // the task still leaves 確認待ち instead of getting stuck; the shield is released.
          deployingRef.current.delete(selected.featureId);
          await api.transition(selected.featureId, "staging_review", { approvedByUser: false });
        }
      } else if (to === "prod_shipped") {
        // staging承認→prod_shipped: 本番も staging と同じ進行UIに繋ぐ。実 run を先にキックして
        // から prod_shipped へ遷移する（順序が逆だと、遷移直後に古い staging run が残ったまま
        // deriveLane が prod_shipped→done と判定し「完了」に一瞬飛ぶ done-flash が起きる）。
        // これで prod_shipped + 走行中 run = 「本番反映中」→ 成功で完了 / 失敗で要修正 になる。
        try {
          await client.startRun(PROD_DEPLOY_PROMPT, { taskId: selected.taskId, ...cwdOpt });
        } catch {
          // daemon down: no progress run possible — fall through to the phase-only ship so
          // the approval still registers (本番反映済) instead of getting stuck in 確認待ち.
        }
        await api.transition(selected.featureId, "prod_shipped", { approvedByUser: true });
      } else {
        await api.transition(selected.featureId, to, { approvedByUser: true });
      }
      await refreshAfterAction();
    },
    [api, client, selected, refreshAfterAction],
  );

  const handleReject = useCallback(
    async (to: FeaturePhase, feedback: string) => {
      if (!selected) return;
      await api.transition(selected.featureId, to, { approvedByUser: false, note: feedback });
      // reject → back to building, then spawn the fix run (feedback carried into the prompt).
      await api.transition(selected.featureId, "demo_building", { approvedByUser: false });
      await startFollowUpRun(selected, feedback);
      await refreshAfterAction();
    },
    [api, selected, startFollowUpRun, refreshAfterAction],
  );

  const handleRerun = useCallback(
    async (prompt: string) => {
      if (!selected) return;
      // If the feature was rejected, reset to building so a success returns it to review.
      if (selected.featurePhase === "demo_rejected" || selected.featurePhase === "staging_rejected") {
        await api.transition(selected.featureId, "demo_building", { approvedByUser: false });
      }
      await startFollowUpRun(selected, prompt);
      await refreshAfterAction();
    },
    [api, selected, startFollowUpRun, refreshAfterAction],
  );

  const handleArchive = useCallback(async () => {
    if (!selected) return;
    if (selected.taskId.startsWith("optimistic-")) return;
    await api.updateTaskStatus(selected.taskId, "done");
    await refreshAfterAction();
  }, [api, selected, refreshAfterAction]);

  const handleCancelRun = useCallback(
    (runId: string) => {
      if (!runId) return;
      void client.cancelRun(runId).finally(() => {
        setTimeout(() => void load(), 500);
      });
    },
    [client, load],
  );

  return (
    <div style={{ color: t.text }}>
      {/* status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: t.space4,
          flexWrap: "wrap",
          marginBottom: t.space5,
        }}
      >
        <button
          type="button"
          data-testid="open-composer"
          onClick={() => setComposerOpen(true)}
          style={btnPrimary}
        >
          + 新規タスク
        </button>
        <span data-testid="concurrency" style={{ fontSize: 13, color: t.textMuted }}>
          走行中 {runningCount} / 目安上限 {concurrencyLimit}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: t.space3, fontSize: 12 }}>
          <HealthDot label="daemon" ok={health.daemon} />
          <HealthDot label="service" ok={health.service} />
        </div>
      </div>

      {health.daemon === false && (
        <div
          data-testid="daemon-down-hint"
          role="status"
          style={{
            marginBottom: t.space4,
            padding: t.space3,
            borderRadius: t.radius,
            border: `1px solid ${t.warning}`,
            fontSize: 13,
            color: t.text,
          }}
        >
          ローカル daemon（127.0.0.1:4319）に接続できません。投入は「投入待ち」に積まれます。起動手順:
          commander/README.md
        </div>
      )}

      {/* lanes */}
      <div
        data-testid="board-lanes"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${LANES.length}, minmax(200px, 1fr))`,
          gap: t.space4,
          overflowX: "auto",
        }}
      >
        {LANES.map((lane) => (
          <section key={lane} data-testid={`lane-${lane}`} style={{ minWidth: 200 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: t.space2,
                marginBottom: t.space3,
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 999, background: LANE_COLORS[lane] }} />
              {LANE_LABELS[lane]}
              <span style={{ color: t.textMuted, fontWeight: 400 }}>{lanes[lane].length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
              {!loaded ? (
                <Skeleton />
              ) : lanes[lane].length === 0 ? (
                <div style={{ fontSize: 12, color: t.textMuted, padding: t.space2 }}>—</div>
              ) : (
                lanes[lane].map((item) => (
                  <TaskCard
                    key={item.taskId}
                    item={item}
                    client={client}
                    history={api}
                    onOpen={setSelectedTaskId}
                    onCancel={handleCancelRun}
                    pending={item.taskId.startsWith("optimistic-")}
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>

      {loaded && all.length === 0 && (
        <div data-testid="board-empty" style={{ marginTop: t.space5, fontSize: 13, color: t.textMuted }}>
          まだタスクがありません。「+ 新規タスク」から最初の指示を投入してください。
        </div>
      )}

      <TaskComposer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onSubmit={handleSubmit}
        submitting={submitting}
        cwdSuggestions={cwdSuggestions}
      />

      <TaskDrawer
        item={selected}
        api={api}
        client={client}
        history={api}
        version={drawerVersion}
        onClose={() => setSelectedTaskId(null)}
        onApprove={handleApprove}
        onReject={handleReject}
        onRerun={handleRerun}
        onArchive={handleArchive}
        onCancelRun={handleCancelRun}
      />
    </div>
  );
}

function HealthDot({ label, ok }: { label: string; ok: boolean | null }) {
  const color = ok === null ? t.textMuted : ok ? t.success : t.danger;
  return (
    <span data-testid={`health-${label}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: t.textMuted }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color }} />
      {label} {ok === null ? "…" : ok ? "稼働" : "停止"}
    </span>
  );
}

function Skeleton() {
  return (
    <div aria-hidden style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
      {[0, 1].map((i) => (
        <div
          key={i}
          style={{
            height: 64,
            borderRadius: t.radius,
            background: t.surface,
            border: `1px solid ${t.border}`,
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}
