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
import { ChatComposer } from "./ChatComposer.tsx";
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
  // Prompts/cwd for tasks registered but NOT yet run (未依頼). Kept client-side (no DB
  // field): the run only starts when the operator presses 「AIに依頼する」.
  const [proposals, setProposals] = useState<Record<string, { prompt: string; cwd: string }>>({});
  const reconcilingRef = useRef(false);

  // Auto-advance deploy-complete markers (non-approval system edges) so a succeeded run
  // lands in 確認待ち. demo_building→demo_review, staging_deployed→staging_review.
  const reconcilePhases = useCallback(
    async (list: BoardItem[]): Promise<boolean> => {
      if (reconcilingRef.current) return false;
      const pending = list.filter(
        (i) =>
          i.latestRun?.status === "succeeded" &&
          (i.featurePhase === "demo_building" || i.featurePhase === "staging_deployed"),
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

  // ── Capture: register the work unit as an UNREQUESTED task (未依頼) ──────────
  // Two deliberate steps replace the old "typing runs it immediately": propose here
  // (create-only, lands in 投入待ち), then 「AIに依頼する」 starts the run (below).
  const proposeTask = useCallback(
    async (v: { title: string; prompt: string; cwd: string; ledgerRef?: string }) => {
      const placeholder: BoardItem = {
        taskId: `optimistic-${Date.now()}`,
        featureId: "",
        title: v.title,
        featurePhase: "demo_building",
        taskStatus: "todo",
        latestRun: null, // no run yet → 投入待ち(未依頼) lane
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setOptimistic((prev) => [placeholder, ...prev]);
      try {
        const res = await api.createTask({ title: v.title, ledgerRef: v.ledgerRef || undefined });
        if (!res.ok) {
          setOptimistic((prev) => prev.filter((o) => o.taskId !== placeholder.taskId));
          return null;
        }
        const taskId = res.value.task.id;
        setProposals((prev) => ({ ...prev, [taskId]: { prompt: v.prompt, cwd: v.cwd } }));
        await load();
        return { taskId };
      } catch {
        setOptimistic((prev) => prev.filter((o) => o.taskId !== placeholder.taskId));
        return null;
      }
    },
    [api, load],
  );

  // ── 「AIに依頼する」: start the run for an already-registered task ────────────
  const requestRun = useCallback(
    async (taskId: string, prompt: string, cwd: string) => {
      if (!prompt.trim()) return;
      await client.startRun(prompt, { taskId, ...(cwd ? { cwd } : {}) });
      setProposals((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      await load();
    },
    [client, load],
  );

  // Detailed composer submit = propose (create-only). Never auto-runs.
  const handleSubmit = useCallback(
    async (v: ComposerSubmit) => {
      setSubmitting(true);
      setComposerOpen(false);
      try {
        await proposeTask({ title: v.title, prompt: v.prompt, cwd: v.cwd, ledgerRef: v.ledgerRef });
      } finally {
        setSubmitting(false);
      }
    },
    [proposeTask],
  );

  // Card 「AIに依頼する」: run with the remembered prompt, else open the drawer to supply one.
  const handleCardRequestRun = useCallback(
    (item: BoardItem) => {
      const prop = proposals[item.taskId];
      if (prop) void requestRun(item.taskId, prop.prompt, prop.cwd);
      else setSelectedTaskId(item.taskId);
    },
    [proposals, requestRun],
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
      await api.transition(selected.featureId, to, { approvedByUser: true });
      // demo承認→staging_deployed: mark staging deploy complete so it re-enters 確認待ち.
      if (to === "staging_deployed") {
        await api.transition(selected.featureId, "staging_review", { approvedByUser: false });
      }
      await refreshAfterAction();
    },
    [api, selected, refreshAfterAction],
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

  // Drawer 「AIに依頼する」: run a queued(未依頼) task with the prompt typed in the drawer.
  const handleDrawerRequestRun = useCallback(
    async (prompt: string) => {
      if (!selected) return;
      const prop = proposals[selected.taskId];
      const cwd = prop?.cwd ?? selected.latestRun?.cwd ?? "";
      await requestRun(selected.taskId, prompt, cwd);
      await refreshAfterAction();
    },
    [selected, proposals, requestRun, refreshAfterAction],
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

      {/* chat capture — the headline entry: type → classify → register(未依頼) → 依頼 */}
      <ChatComposer
        onPropose={proposeTask}
        onRequestRun={requestRun}
        defaultCwd={cwdSuggestions[0] ?? ""}
      />

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
                    onRequestRun={handleCardRequestRun}
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
        onRequestRun={handleDrawerRequestRun}
        requestPromptDefault={selected ? (proposals[selected.taskId]?.prompt ?? "") : ""}
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
