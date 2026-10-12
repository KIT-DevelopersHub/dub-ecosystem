// UI 確認用のインメモリ API（demo.html 専用・本番ビルドには入らない）。実 daemon / service を
// 叩かずに、枠待ちタスクの合体 → 反映 → 子ごとの承認・却下までをボード上で動かせる。
import { allowedTransitions } from "@dub/commander-phases";
import type { CommanderClient, DaemonRunEvent } from "../lib/client.ts";
import type {
  BoardItem,
  BundleApi,
  BundleIssue,
  CommanderApi,
  FeatureDetail,
  FeaturePhase,
  RunDetail,
  RunStatus,
  StagingBundle,
} from "../lib/commanderApi.ts";

const PR = (n: number) => `https://github.com/KIT-DevelopersHub/dub-ecosystem/pull/${n}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

interface Seed {
  title: string;
  phase: FeaturePhase;
  run: RunStatus | null;
  pr?: number;
  staging?: string;
  demo?: boolean;
  min: number;
  /** checkBundle 用の性質 */
  migration?: boolean;
  mail?: boolean;
  touches?: string[];
}

const SEEDS: Seed[] = [
  { title: "LP のヘッダーを新デザインに", phase: "demo_building", run: null, min: 3 },
  { title: "チャットの未読バッジ", phase: "demo_building", run: "running", min: 6 },
  { title: "イベント一覧の並び替え", phase: "demo_review", run: "succeeded", pr: 620, demo: true, min: 25 },
  { title: "通知の一括既読", phase: "staging_review", run: "succeeded", pr: 615, demo: true, min: 50, touches: ["notification"] },
  { title: "メンバー検索の高速化", phase: "staging_review", run: "succeeded", pr: 616, demo: true, min: 70, touches: ["identity"] },
  { title: "受信メールの添付表示", phase: "staging_deployed", run: "succeeded", pr: 617, demo: true, min: 90, mail: true, touches: ["mail"] },
  { title: "参加届に学年を追加", phase: "staging_review", run: "succeeded", pr: 618, demo: true, min: 95, migration: true, touches: ["event"] },
  { title: "Drive 共有リンクの期限", phase: "staging_review", run: "succeeded", pr: 610, demo: true, staging: "https://dub-fe2-staging.example.workers.dev", min: 300 },
  { title: "LP v3.5", phase: "staging_review", run: "succeeded", pr: 603, demo: true, staging: "https://dub-fe2-staging2.example.workers.dev", min: 400 },
  { title: "使用量ダッシュボード", phase: "prod_shipped", run: "succeeded", pr: 600, demo: true, min: 900 },
];

export function makeDemo(): { api: CommanderApi; client: CommanderClient } {
  const items: BoardItem[] = SEEDS.map((s, n) => ({
    taskId: `task-${n + 1}`,
    featureId: `feat-${n + 1}`,
    title: s.title,
    featurePhase: s.phase,
    taskStatus: "todo",
    demoUrl: s.demo ? `https://dub-demo-${n + 1}.example.workers.dev` : null,
    stagingUrl: s.staging ?? null,
    prUrl: s.pr ? PR(s.pr) : null,
    prUrls: s.pr ? [PR(s.pr)] : [],
    latestRun: s.run ? { id: `run-${n + 1}`, status: s.run, cwd: `/wt/feature-${n + 1}`, createdAt: ago(s.min) } : null,
    createdAt: ago(s.min + 60),
    updatedAt: ago(s.min),
  }));
  const seedOf = (taskId: string): Partial<Seed> => SEEDS[Number(taskId.split("-")[1]) - 1] ?? {};
  const itemOf = (taskId: string) => items.find((i) => i.taskId === taskId)!;
  const runs = new Map<string, RunDetail>();
  let seq = 100;
  let bundles: StagingBundle[] = [];

  const ev = (runId: string, line: string): RunDetail["events"][number] => ({
    id: `ev-${seq++}`,
    runId,
    type: "stdout",
    payload: { line },
    createdAt: new Date().toISOString(),
  });
  for (const i of items) {
    if (!i.latestRun) continue;
    runs.set(i.latestRun.id, {
      run: { id: i.latestRun.id, taskId: i.taskId, prompt: `${i.title} を実装して demo に反映`, cwd: i.latestRun.cwd, status: i.latestRun.status, exitCode: 0, createdAt: i.latestRun.createdAt, updatedAt: i.latestRun.createdAt },
      events: [ev(i.latestRun.id, `「${i.title}」を実装しました`), ev(i.latestRun.id, i.demoUrl ? `demo: ${i.demoUrl}` : "作業中…")],
    });
  }

  // 統合 → 反映 → 子のマーカーを順に実測、をタイマーで再現する。
  const deploy = (b: StagingBundle) => {
    b.status = "merging";
    b.stagingUrl = null;
    for (const id of b.taskIds) {
      b.markers[id] = "pending";
      itemOf(id).featurePhase = "staging_deployed";
    }
    setTimeout(() => {
      if (!bundles.includes(b)) return;
      b.status = "deployed";
      b.stagingUrl = `https://dub-fe2-${b.slot}.example.workers.dev`;
      b.taskIds.forEach((id, n) =>
        setTimeout(() => {
          if (!b.taskIds.includes(id)) return;
          b.markers[id] = "pass";
          const it = itemOf(id);
          it.featurePhase = "staging_review";
          it.stagingUrl = b.stagingUrl;
          it.updatedAt = new Date().toISOString();
        }, 800 * (n + 1)),
      );
    }, 5000);
  };

  const bundleApi: BundleApi = {
    listBundles: async () => bundles.map((b) => ({ ...b, taskIds: [...b.taskIds], markers: { ...b.markers } })),
    checkBundle: async (taskIds) => {
      await new Promise((r) => setTimeout(r, 900));
      const out: BundleIssue[] = [];
      const mig = taskIds.filter((id) => seedOf(id).migration);
      if (mig.length) out.push({ taskIds: mig, message: "D1 マイグレーションを含むため合体できません（単独で枠を待ってください）", block: true });
      const mail = taskIds.filter((id) => seedOf(id).mail);
      if (mail.length) out.push({ taskIds: mail, message: "メール受信を使うので枠1（stagingへ）に載せます", block: false });
      return out;
    },
    createBundle: async (taskIds) => {
      const b: StagingBundle = {
        id: `bundle-${seq++}`,
        taskIds: [...taskIds],
        status: "merging",
        slot: taskIds.some((id) => seedOf(id).mail) ? "staging" : "staging2",
        stagingUrl: null,
        branch: `staging/bundle-${seq}`,
        markers: {},
        createdAt: new Date().toISOString(),
      };
      bundles = [b, ...bundles];
      deploy(b);
      return { ok: true, value: b };
    },
    removeFromBundle: async (bundleId, taskId) => {
      const b = bundles.find((x) => x.id === bundleId);
      if (!b) return { ok: true, value: null };
      b.taskIds = b.taskIds.filter((id) => id !== taskId);
      delete b.markers[taskId];
      if (b.taskIds.length === 0) {
        bundles = bundles.filter((x) => x !== b);
        return { ok: true, value: null };
      }
      return { ok: true, value: b };
    },
    dissolveBundle: async (bundleId) => {
      const b = bundles.find((x) => x.id === bundleId);
      if (b) {
        for (const id of b.taskIds) {
          const it = itemOf(id);
          it.featurePhase = "staging_review";
          it.stagingUrl = null;
        }
        bundles = bundles.filter((x) => x !== b);
      }
      return { ok: true, value: null };
    },
  };

  const listeners = new Map<string, (e: DaemonRunEvent) => void>();
  const finishRun = (runId: string) => {
    const d = runs.get(runId);
    if (!d) return;
    d.run.status = "succeeded";
    d.events.push(ev(runId, "完了しました"));
    const it = items.find((i) => i.latestRun?.id === runId);
    if (it?.latestRun) it.latestRun = { ...it.latestRun, status: "succeeded" };
    listeners.get(runId)?.({ type: "status", status: "succeeded" });
  };

  const client: CommanderClient = {
    startRun: async (prompt, opts) => {
      const runId = `run-${seq++}`;
      const it = items.find((i) => i.taskId === opts?.taskId);
      const now = new Date().toISOString();
      runs.set(runId, {
        run: { id: runId, taskId: opts?.taskId ?? null, prompt, cwd: opts?.cwd ?? "/wt", status: "running", exitCode: null, createdAt: now, updatedAt: now },
        events: [ev(runId, "実行を開始しました")],
      });
      if (it) {
        it.latestRun = { id: runId, status: "running", cwd: opts?.cwd ?? "/wt", createdAt: now };
        it.updatedAt = now;
      }
      setTimeout(() => finishRun(runId), 6000);
      return { runId };
    },
    cancelRun: async (runId) => finishRun(runId),
    health: async () => true,
    streamEvents: (runId, onEvent, onClose) => {
      listeners.set(runId, (e) => {
        onEvent(e);
        if (e.type === "status" && e.status !== "running") onClose();
      });
      return () => listeners.delete(runId);
    },
  };

  const okTask = (id: string) => {
    const it = items.find((i) => i.taskId === id);
    return { id, featureId: it?.featureId ?? "", title: it?.title ?? "", status: it?.taskStatus ?? "todo", createdAt: "", updatedAt: "" };
  };

  const api: CommanderApi = {
    bundles: bundleApi,
    listBoard: async () => items.map((i) => ({ ...i })),
    listFeatures: async () => [],
    createFeature: async () => ({ ok: false, error: { status: 400, error: "demo" } }),
    getFeature: async (id): Promise<FeatureDetail> => {
      const it = items.find((i) => i.featureId === id)!;
      return {
        feature: { id, title: it.title, phase: it.featurePhase, ledgerRef: null, createdAt: it.createdAt, updatedAt: it.updatedAt },
        allowedTransitions: allowedTransitions(it.featurePhase).map((tr) => ({ ...tr })),
        transitions: [],
      };
    },
    transition: async (id, to, opts) => {
      const it = items.find((i) => i.featureId === id)!;
      const from = it.featurePhase;
      it.featurePhase = to;
      it.updatedAt = new Date().toISOString();
      if (to === "demo_building") it.stagingUrl = null;
      return {
        ok: true,
        value: {
          feature: { id, title: it.title, phase: to, ledgerRef: null, createdAt: it.createdAt, updatedAt: it.updatedAt },
          transition: { id: `tx-${seq++}`, featureId: id, fromPhase: from, toPhase: to, approvedByUser: !!opts?.approvedByUser, actor: "user", note: opts?.note ?? null, createdAt: it.updatedAt },
        },
      };
    },
    listRuns: async () => [...runs.values()].map((d) => d.run),
    getRun: async (id) => runs.get(id) ?? null,
    createTask: async ({ title }) => {
      const n = items.length + 1;
      const now = new Date().toISOString();
      items.unshift({ taskId: `task-${n}`, featureId: `feat-${n}`, title, featurePhase: "demo_building", taskStatus: "todo", demoUrl: null, stagingUrl: null, prUrl: null, prUrls: [], latestRun: null, createdAt: now, updatedAt: now });
      SEEDS.push({ title, phase: "demo_building", run: null, min: 0 });
      return {
        ok: true,
        value: {
          feature: { id: `feat-${n}`, title, phase: "demo_building", ledgerRef: null, createdAt: now, updatedAt: now },
          task: { id: `task-${n}`, featureId: `feat-${n}`, title, status: "todo", createdAt: now, updatedAt: now },
        },
      };
    },
    updateTaskStatus: async (id, status) => {
      const it = items.find((i) => i.taskId === id);
      if (it) it.taskStatus = status;
      return { ok: true, value: { ...okTask(id), status } };
    },
    backfillTaskUrls: async () => ({ updated: 0 }),
    health: async () => true,
    listChats: async () => [],
    createChat: async (kind, title = "") => ({ id: `chat-${seq++}`, kind, title, createdAt: "", updatedAt: "" }),
    getChat: async () => null,
    renameChat: async () => null,
    deleteChat: async () => true,
    addChatMessage: async () => null,
    updateChatMessage: async () => null,
  };
  return { api, client };
}
