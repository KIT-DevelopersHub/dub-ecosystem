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
  type StagingBundle,
} from "./lib/commanderApi.ts";
import {
  groupByLane,
  isReviewLane,
  isRunningLane,
  LANES,
  LANE_COLORS,
  LANE_DESCRIPTIONS,
  LANE_LABELS,
  type Lane,
} from "./lib/lanes.ts";
import { matchesFilter } from "./lib/filter.ts";
import {
  bundleChildren,
  bundleLane,
  bundleOfTask,
  bundleBlocker,
  bundleCleanupPrompt,
  bundleDeployPrompt,
  withoutBundled,
} from "./lib/bundles.ts";
import { TaskCard } from "./TaskCard.tsx";
import { BundleCard, BUNDLE_COLOR } from "./BundleCard.tsx";
import { BundleComposer } from "./BundleComposer.tsx";
import { DoneList } from "./DoneList.tsx";
import { TaskComposer, type ComposerSubmit } from "./TaskComposer.tsx";
import { TaskDrawer } from "./TaskDrawer.tsx";
import { btnGhost, btnPrimary, input, t } from "./lib/theme.ts";
import type { ChatImage } from "./lib/images.ts";
import { imageNote } from "./lib/chatStore.tsx";

// ホバー表現はインラインstyleで書けないので、ボード内だけに効くクラスを1つの<style>で持つ。
const BOARD_CSS = `
.cmdr-card { transition: border-color .12s, box-shadow .12s; }
.cmdr-card:hover { border-color: var(--dub-color-border-strong, #3f4759); box-shadow: 0 1px 6px rgba(0,0,0,.25); }
.cmdr-card:focus-visible, .cmdr-row:focus-visible { outline: 2px solid var(--dub-color-brand-500, #3358e8); outline-offset: 1px; }
.cmdr-card:hover .cmdr-card-title { text-decoration: underline; }
.cmdr-row:hover { background: var(--dub-color-surface-raised, #1a1e27); }
.cmdr-add:hover { background: var(--dub-color-surface-raised, #1a1e27); color: var(--dub-color-text-primary, #e6e6e6); }
.cmdr-pick > .cmdr-card { flex: 1; min-width: 0; }
.cmdr-pick[data-picked="true"] > .cmdr-card { border-color: var(--dub-color-accent-500, #8b5cf6); box-shadow: 0 0 0 1px var(--dub-color-accent-500, #8b5cf6); }
.cmdr-pick[data-disabled="true"] { opacity: .4; }
.cmdr-pick[data-disabled="true"] > .cmdr-card { cursor: not-allowed; }
.cmdr-cancel:hover { color: var(--dub-color-danger-500, #e5484d); border-color: var(--dub-color-danger-500, #e5484d); }
`;

/** 列の幅。GitHub Project 同様に固定幅寄りで並べ、最小幅を割るなら横スクロール。 */
function columnSize(lane: Lane, count: number, loaded: boolean): { flex: string; minWidth: number } {
  if (loaded && count === 0) return { flex: "0 0 164px", minWidth: 164 }; // 空の列は細く(見出しは切らない)
  if (lane === "done") return { flex: "1.2 1 280px", minWidth: 260 };
  return { flex: "1 1 240px", minWidth: 220 };
}

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

/** Start a run with pasted screenshots: stage each on the daemon, then pass the ids. The
 *  prompt notes the count so later follow-ups (which re-inject it) know images were sent. */
async function startRunWithImages(
  client: CommanderClient,
  prompt: string,
  opts: { taskId?: string; cwd?: string },
  images: ChatImage[],
): Promise<{ runId: string }> {
  if (images.length === 0) return client.startRun(prompt, opts);
  const uploaded = await Promise.all(images.map((img) => client.uploadImage(img)));
  return client.startRun(`${prompt}\n${imageNote(images.length)}`, {
    ...opts,
    images: uploaded.map((u) => u.uploadId),
  });
}

// Instruction the staging反映 run carries when the user approves demo → staging. This is
// what makes 「stgに進む」 do real work (not just flip the phase): the daemon spawns a run
// in the task's worktree that merges the demo-approved版そのもの into staging and deploys,
// and its live progress is what the board shows as 「staging反映中…」 until it succeeds
// (→ 確認待ち via reconcilePhases) or fails (→ 要修正).
export const STAGING_DEPLOY_PROMPT =
  "[commander] このタスクの demo で承認された版そのものを staging に反映してください。" +
  "手順: (1) demo承認版の PR を用意 (別物を混ぜない・diff照合)、" +
  "(2) `bash scripts/staging-pick-slot.sh --pr <PR番号>` で空いている staging 枠を選び、" +
  "出力の label (`staging2へ` か `stagingへ`) を PR に付けて staging.yml で反映 (両方埋まっていれば待つ)、" +
  "(3) `bash scripts/verify-live.sh <出力の verify_env> \"<マーカー>\"` で配信物にマーカーが実在することを実測、" +
  "(4) 完了したら staging URL を1行で出力し、最終行に `これに付けて: <PR URL>` を1行書く。反映が確認できるまで完了扱いにしないでください。" +
  "この run は staging までです。`確認した` ラベルは絶対に付けない (オーナーだけが付ける)。main へのマージ・本番デプロイもしない。";

// Instruction the本番反映 run carries when the user approves staging → prod. Mirrors the
// staging反映 run so 本番承認 も同じ進行UI（本番反映中 → 完了/失敗）に繋がる: the daemon
// spawns a real run that ships the staging-approved版そのもの to 本番, and its live progress
// is what the board shows as 「本番反映中」 until it settles (→本番確認中). The run never
// applies 「確認した」 itself — only the owner does; without it the run stops and asks.
export const PROD_DEPLOY_PROMPT =
  "[commander] このタスクの staging で承認された版そのものを本番に反映してください。" +
  "手順: (1) `gh pr view <PR> --json labels,baseRefName` で対象 PR に `確認した` ラベルが付いているか確かめる。" +
  "`確認した` はオーナーだけが付けるラベルなので、自分では絶対に付けない。付いていなければ何もマージせず、最終行に `これに付けて: <PR URL>` を1行書いて終了する。" +
  "(2) 付いていれば staging 承認版と同じであること (別物を混ぜない・diff照合) を確かめ、`gh pr merge <PR> --merge` で main にマージする (`--admin` 禁止)。" +
  "本番デプロイは main マージで deploy.yml が自動で行う。手元からの `wrangler deploy` や `gh workflow run` で本番に出さない。" +
  "(3) deploy.yml の完了を `gh run watch` で待ち、`bash scripts/verify-live.sh prod \"<マーカー>\"` で配信物にマーカーが実在することを実測、" +
  "(4) 完了したら本番 URL を1行で出力。反映が確認できるまで完了扱いにしないでください。";

// Phases a 追加指示 must rewind to demo_building before the follow-up run starts
// (却下済み =「直して再 demo」). Every other phase keeps its phase: the follow-up run is
// just added to the same task. Moving back is the explicit 「フェーズを戻す」 action.
const REWORK_RESET_PHASES: ReadonlySet<FeaturePhase> = new Set<FeaturePhase>([
  "demo_rejected",
  "staging_rejected",
]);

export function Board({
  client = defaultClient,
  api = defaultApi,
  pollMs = 3000,
  concurrencyLimit = 3,
  cwdPins = [],
}: BoardProps) {
  const [items, setItems] = useState<BoardItem[]>([]);
  const [bundles, setBundles] = useState<StagingBundle[]>([]);
  // 合体の選択モード（null = 通常）。選んだ taskId を持つ。
  const [picking, setPicking] = useState<Set<string> | null>(null);
  const [bundleComposerOpen, setBundleComposerOpen] = useState(false);
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
  // Feature ids whose next run was just kicked (staging反映 / 追加指示の修正 run) but whose
  // new (pending) run may not be visible on the board yet. While a feature sits here,
  // reconcilePhases must NOT auto-advance off the *stale* (already succeeded) run —
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
      if (api.bundles) setBundles(await api.bundles.listBundles().catch(() => []));
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
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => all.filter((i) => matchesFilter(i, query)), [all, query]);
  const lanes = useMemo(() => groupByLane(withoutBundled(shown, bundles)), [shown, bundles]);
  // 束は子のどれかが絞り込みに一致すれば出す。
  const bundleLanes = useMemo(() => {
    const out = Object.fromEntries(LANES.map((l) => [l, [] as StagingBundle[]])) as Record<Lane, StagingBundle[]>;
    for (const b of bundles) {
      if (bundleChildren(b, shown).length > 0) out[bundleLane(b)].push(b);
    }
    return out;
  }, [bundles, shown]);
  const bundleByTask = useMemo(() => bundleOfTask(bundles), [bundles]);
  const candidates = useMemo(
    () => (api.bundles ? withoutBundled(all, bundles).filter((i) => bundleBlocker(i) === null) : []),
    [api.bundles, all, bundles],
  );
  const candidateIds = useMemo(() => new Set(candidates.map((i) => i.taskId)), [candidates]);

  // GitHub と同じく「/」でフィルターへ移動（入力中のキーは奪わない）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (!filterRef.current || filterRef.current.closest("[hidden]")) return; // 非表示タブ
      e.preventDefault();
      filterRef.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 件数サマリーはフィルターに左右されない（絞り込み中でも全体の状況を見せる）。
  const allLanes = useMemo(() => groupByLane(withoutBundled(all, bundles)), [all, bundles]);
  const runningCount =
    LANES.filter(isRunningLane).reduce((n, l) => n + allLanes[l].length, 0) +
    bundles.filter((b) => b.status === "merging").length;
  // Ball is on the operator's side: every card in a 確認 column (要修正 included).
  const reviewCount =
    LANES.filter(isReviewLane).reduce((n, l) => n + allLanes[l].length, 0) +
    bundles.filter((b) => b.status !== "merging").reduce((n, b) => n + bundleChildren(b, all).length, 0);
  const filtering = query.trim() !== "";

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
        prUrls: [],
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
        await startRunWithImages(
          client,
          v.prompt,
          { taskId: res.value.task.id, ...(v.cwd ? { cwd: v.cwd } : {}) },
          v.images,
        );
        await load();
      } catch {
        setOptimistic((prev) => prev.filter((o) => o.taskId !== placeholder.taskId));
      } finally {
        setSubmitting(false);
      }
    },
    [api, client, load],
  );

  // ── staging 合体 ────────────────────────────────────────────────────────────
  // 子は staging で承認・却下された時点で束を抜ける（本番 / demo へ個別に進む）。残りは束のまま。
  // 束が消える時は統合 PR とブランチを run で片付ける（統合中なら先に止める）。
  const cleanUpBundle = useCallback(
    async (b: StagingBundle) => {
      if (b.status === "merging" && b.runId) await client.cancelRun(b.runId).catch(() => {});
      await client.startRun(bundleCleanupPrompt(b)).catch(() => {});
    },
    [client],
  );

  const leaveBundle = useCallback(
    async (taskId: string) => {
      const b = bundleByTask.get(taskId);
      if (!b || !api.bundles) return;
      const res = await api.bundles.removeFromBundle(b.id, taskId);
      if (res.ok && res.value === null) await cleanUpBundle(b);
    },
    [api, bundleByTask, cleanUpBundle],
  );

  const togglePick = useCallback((taskId: string) => {
    setPicking((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const pickedItems = useMemo(
    () => (picking ? candidates.filter((i) => picking.has(i.taskId)) : []),
    [picking, candidates],
  );

  const handleCreateBundle = useCallback(async () => {
    if (!api.bundles || pickedItems.length < 2) return;
    const res = await api.bundles.createBundle(pickedItems.map((i) => i.taskId));
    if (!res.ok) return;
    try {
      const { runId } = await client.startRun(bundleDeployPrompt(res.value, pickedItems));
      await api.bundles.attachRun(res.value.id, runId);
    } catch {
      // run を起動できない束は残さない（統合中のまま止まって見えるのを防ぐ）。
      await api.bundles.dissolveBundle(res.value.id);
      return;
    }
    setBundleComposerOpen(false);
    setPicking(null);
    await load();
  }, [api, client, pickedItems, load]);

  const handleDissolve = useCallback(
    async (bundleId: string) => {
      const b = bundles.find((x) => x.id === bundleId);
      if (!api.bundles || !b) return;
      const res = await api.bundles.dissolveBundle(bundleId);
      if (res.ok) await cleanUpBundle(b);
      await load();
    },
    [api, bundles, cleanUpBundle, load],
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
    async (item: BoardItem, addition: string, images: ChatImage[] = []) => {
      const prior = await priorPrompt(item.latestRun?.id);
      await startRunWithImages(
        client,
        composePrompt(prior, addition),
        { taskId: item.taskId, ...(item.latestRun?.cwd ? { cwd: item.latestRun.cwd } : {}) },
        images,
      );
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
        // deriveLane が古い run の結果で「本番確認中」に一瞬飛ぶ flash が起きる）。
        // これで prod_shipped + 走行中 run = 「本番反映中」→ 終われば「本番確認中」(失敗は要修正表示)。
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
      await leaveBundle(selected.taskId);
      await refreshAfterAction();
    },
    [api, client, selected, refreshAfterAction, leaveBundle],
  );

  const handleReject = useCallback(
    async (to: FeaturePhase, feedback: string, images: ChatImage[] = []) => {
      if (!selected) return;
      await api.transition(selected.featureId, to, { approvedByUser: false, note: feedback });
      // reject → back to building, then spawn the fix run (feedback carried into the prompt).
      await api.transition(selected.featureId, "demo_building", { approvedByUser: false });
      await startFollowUpRun(selected, feedback, images);
      await leaveBundle(selected.taskId);
      await refreshAfterAction();
    },
    [api, selected, startFollowUpRun, refreshAfterAction, leaveBundle],
  );

  const handleRerun = useCallback(
    async (prompt: string, images: ChatImage[] = []) => {
      if (!selected) return;
      // A rejected feature is reset to demo_building so a successful fix run returns it to
      // 確認待ち. Any other phase (本番反映済 included) stays where it is.
      const needsReset = REWORK_RESET_PHASES.has(selected.featurePhase);
      // Shield the feature until the new run is visible — between the reset and the run
      // kick the board still sees the *stale* succeeded run and would otherwise
      // auto-advance demo_building→demo_review (card flashes 確認待ち with no work done).
      if (needsReset) deployingRef.current.add(selected.featureId);
      try {
        if (needsReset) {
          await api.transition(selected.featureId, "demo_building", { approvedByUser: false });
        }
        await startFollowUpRun(selected, prompt, images);
      } catch (e) {
        deployingRef.current.delete(selected.featureId);
        throw e;
      }
      await refreshAfterAction();
    },
    [api, selected, startFollowUpRun, refreshAfterAction],
  );

  // 「フェーズを戻す」: phase-only step back to a 確認待ち phase. No run is started and no
  // deployed environment is rolled back.
  const handleRewind = useCallback(
    async (to: FeaturePhase) => {
      if (!selected) return;
      await api.transition(selected.featureId, to, {
        approvedByUser: false,
        note: "ユーザー操作: フェーズを戻す",
      });
      await refreshAfterAction();
    },
    [api, selected, refreshAfterAction],
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
      <style>{BOARD_CSS}</style>
      {/* toolbar: filter (GitHub Project の "Filter by keyword") + counts + new task */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: t.space4,
          flexWrap: "wrap",
          marginBottom: t.space3,
        }}
      >
        <div style={{ position: "relative", flex: "1 1 320px", maxWidth: 560 }}>
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: t.space3,
              top: "50%",
              transform: "translateY(-50%)",
              color: t.textMuted,
              fontSize: 13,
              pointerEvents: "none",
            }}
          >
            ⌕
          </span>
          <input
            ref={filterRef}
            type="search"
            data-testid="board-filter"
            aria-label="タスクを絞り込む"
            placeholder="タイトル・PR 番号・フォルダで絞り込み（/ で移動）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            style={{ ...input, paddingLeft: 30, fontSize: 13 }}
          />
        </div>
        <span data-testid="concurrency" style={{ fontSize: 13, color: t.textMuted }}>
          走行中 {runningCount} / 目安上限 {concurrencyLimit}
        </span>
        <span
          data-testid="review-count"
          style={{
            fontSize: 13,
            fontWeight: reviewCount > 0 ? 700 : 400,
            color: reviewCount > 0 ? LANE_COLORS.review : t.textMuted,
          }}
        >
          あなたの確認待ち {reviewCount}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: t.space4 }}>
          <div style={{ display: "flex", gap: t.space3, fontSize: 12 }}>
            <HealthDot label="daemon" ok={health.daemon} />
            <HealthDot label="service" ok={health.service} />
          </div>
          {api.bundles && !picking && (candidates.length >= 2 || bundles.length > 0) && (
            <button
              type="button"
              data-testid="start-bundle"
              disabled={candidates.length < 2}
              title={candidates.length < 2 ? "枠待ちのタスクが 2 件以上あると合体できます" : "枠待ちのタスクをまとめて 1 つの staging 枠に載せる"}
              onClick={() => setPicking(new Set())}
              style={{ ...btnGhost, opacity: candidates.length < 2 ? 0.5 : 1 }}
            >
              <span aria-hidden style={{ color: BUNDLE_COLOR }}>⧉</span> 合体
              {candidates.length >= 2 && <span style={{ color: t.textMuted, fontWeight: 400 }}>（枠待ち {candidates.length}）</span>}
            </button>
          )}
          <button
            type="button"
            data-testid="open-composer"
            onClick={() => setComposerOpen(true)}
            style={btnPrimary}
          >
            + 新規タスク
          </button>
        </div>
      </div>

      {filtering && (
        <div
          data-testid="filter-summary"
          style={{ display: "flex", alignItems: "center", gap: t.space2, marginBottom: t.space3, fontSize: 12, color: t.textMuted }}
        >
          {shown.length} / {all.length} 件を表示中
          <button
            type="button"
            data-testid="filter-clear"
            onClick={() => setQuery("")}
            style={{ background: "transparent", border: 0, color: t.primary, cursor: "pointer", font: "inherit", padding: 0 }}
          >
            絞り込みを解除
          </button>
        </div>
      )}

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

      {picking && (
        <div
          data-testid="bundle-picker"
          role="region"
          aria-label="合体するタスクを選ぶ"
          style={{
            display: "flex",
            alignItems: "center",
            gap: t.space3,
            flexWrap: "wrap",
            marginBottom: t.space3,
            padding: `${t.space2} ${t.space3}`,
            borderRadius: t.radius,
            border: `1px solid ${BUNDLE_COLOR}`,
            fontSize: 13,
          }}
        >
          <span aria-hidden style={{ color: BUNDLE_COLOR, fontWeight: 700 }}>⧉</span>
          <span>
            合体するタスクを 2 つ以上選んでください。選べるのは<strong>枠待ち</strong>（demo 承認済み・staging 未反映）のタスクだけです。
          </span>
          <span style={{ marginLeft: "auto", display: "flex", gap: t.space2 }}>
            <button type="button" data-testid="bundle-pick-cancel" onClick={() => setPicking(null)} style={btnGhost}>
              やめる
            </button>
            <button
              type="button"
              data-testid="bundle-pick-next"
              disabled={pickedItems.length < 2}
              onClick={() => setBundleComposerOpen(true)}
              style={{ ...btnPrimary, opacity: pickedItems.length < 2 ? 0.5 : 1, cursor: pickedItems.length < 2 ? "not-allowed" : "pointer" }}
            >
              {pickedItems.length} 件を合体…
            </button>
          </span>
        </div>
      )}

      {/* lanes */}
      <div
        data-testid="board-lanes"
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: t.space3,
          overflowX: "auto",
          paddingBottom: t.space2,
        }}
      >
        {LANES.map((lane) => (
          <section
            key={lane}
            data-testid={`lane-${lane}`}
            aria-label={LANE_LABELS[lane]}
            style={{
              ...columnSize(lane, lanes[lane].length + bundleLanes[lane].length, loaded),
              display: "flex",
              flexDirection: "column",
              background: t.sunken,
              border: `1px solid ${t.border}`,
              borderRadius: t.radius,
              // 列ごとに縦スクロール（ボード全体は伸ばさない）。
              maxHeight: "calc(100vh - 220px)",
              minHeight: 240,
            }}
          >
            <header style={{ padding: `${t.space3} ${t.space3} ${t.space2}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: t.space2, fontSize: 14, fontWeight: 600 }}>
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 999,
                    border: `2px solid ${LANE_COLORS[lane]}`,
                    boxSizing: "border-box",
                    flexShrink: 0,
                  }}
                />
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {LANE_LABELS[lane]}
                </span>
                <span
                  data-testid={`lane-count-${lane}`}
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: t.textMuted,
                    background: t.overlay,
                    border: `1px solid ${t.border}`,
                    borderRadius: 999,
                    padding: "0 8px",
                    lineHeight: "18px",
                  }}
                >
                  {lanes[lane].length + bundleLanes[lane].length}
                </span>
              </div>
              <div
                style={{
                  marginTop: t.space1,
                  fontSize: 12,
                  color: t.textMuted,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {LANE_DESCRIPTIONS[lane]}
              </div>
            </header>
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: t.space2,
                padding: `0 ${t.space2} ${t.space2}`,
              }}
            >
              {!loaded ? (
                <Skeleton />
              ) : lane === "done" && lanes.done.length > 0 ? (
                <DoneList items={lanes.done} onOpen={setSelectedTaskId} />
              ) : lanes[lane].length + bundleLanes[lane].length === 0 ? (
                <div style={{ fontSize: 12, color: t.textMuted, padding: t.space2, textAlign: "center" }}>
                  {filtering ? "一致なし" : "なし"}
                </div>
              ) : (
                <>
                  {bundleLanes[lane].map((b) => (
                    <BundleCard
                      key={b.id}
                      bundle={b}
                      items={bundleChildren(b, all)}
                      onOpenChild={setSelectedTaskId}
                      onDissolve={(id) => void handleDissolve(id)}
                    />
                  ))}
                  {lanes[lane].map((item) => {
                    const blocker = picking ? bundleBlocker(item) : null;
                    const card = (
                      <TaskCard
                        key={item.taskId}
                        item={item}
                        client={client}
                        history={api}
                        onOpen={!picking ? setSelectedTaskId : blocker ? () => {} : togglePick}
                        onCancel={handleCancelRun}
                        pending={item.taskId.startsWith("optimistic-")}
                        slotWaiting={candidateIds.has(item.taskId)}
                      />
                    );
                    if (!picking) return card;
                    const picked = picking.has(item.taskId);
                    return (
                      <div
                        key={item.taskId}
                        className="cmdr-pick"
                        style={{ display: "flex", alignItems: "flex-start", gap: t.space2 }}
                        data-testid={`bundle-pick-${item.taskId}`}
                        data-picked={picked}
                        data-disabled={!!blocker}
                        title={blocker ? `合体できません: ${blocker}` : undefined}
                      >
                        {
                          <span
                            aria-hidden
                            style={{
                              marginTop: 12,
                              flexShrink: 0,
                              width: 16,
                              height: 16,
                              borderRadius: 4,
                              border: `2px solid ${blocker ? t.border : BUNDLE_COLOR}`,
                              background: picked ? BUNDLE_COLOR : "transparent",
                              color: "#fff",
                              fontSize: 11,
                              lineHeight: "12px",
                              textAlign: "center",
                              boxSizing: "border-box",
                            }}
                          >
                            {picked ? "✓" : ""}
                          </span>
                        }
                        {card}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            {lane === "queued" && (
              <button
                type="button"
                data-testid="lane-add-task"
                className="cmdr-add"
                onClick={() => setComposerOpen(true)}
                style={{
                  margin: `0 ${t.space2} ${t.space2}`,
                  padding: `${t.space2} ${t.space2}`,
                  textAlign: "left",
                  background: "transparent",
                  border: 0,
                  borderRadius: "var(--dub-radius-sm, 8px)",
                  color: t.textMuted,
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: 13,
                  whiteSpace: "nowrap",
                }}
              >
                + タスクを追加
              </button>
            )}
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

      {api.bundles && (
        <BundleComposer
          open={bundleComposerOpen}
          items={pickedItems}
          api={api.bundles}
          onClose={() => setBundleComposerOpen(false)}
          onConfirm={handleCreateBundle}
        />
      )}

      <TaskDrawer
        item={selected}
        notice={selected && bundleByTask.has(selected.taskId) ? (
          <BundleNotice
            others={bundleChildren(bundleByTask.get(selected.taskId)!, all).filter((i) => i.taskId !== selected.taskId)}
          />
        ) : undefined}
        api={api}
        client={client}
        history={api}
        version={drawerVersion}
        onClose={() => setSelectedTaskId(null)}
        onApprove={handleApprove}
        onReject={handleReject}
        onRerun={handleRerun}
        onRewind={handleRewind}
        onArchive={handleArchive}
        onCancelRun={handleCancelRun}
      />
    </div>
  );
}

/** 合体に入っている子のドロワー冒頭に出す注記。 */
function BundleNotice({ others }: { others: BoardItem[] }) {
  return (
    <div
      data-testid="drawer-bundle-notice"
      style={{
        marginBottom: t.space4,
        padding: t.space3,
        borderRadius: t.radius,
        border: `1px solid ${BUNDLE_COLOR}`,
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <span aria-hidden style={{ color: BUNDLE_COLOR, fontWeight: 700 }}>⧉ </span>
      合体して staging に載っています
      {others.length > 0 && <>（一緒に: {others.map((o) => o.title).join(" / ")}）</>}。
      承認・却下は<strong>このタスクだけ</strong>に効き、決まったタスクは合体から抜けます。
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
