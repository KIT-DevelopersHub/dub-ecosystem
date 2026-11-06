// Demo/mock mode (VITE_COMMANDER_DEMO=1): the board with sample tasks and an in-memory PR
// API, so the UI can be tried without the daemon, commander-service or GitHub. Nothing here
// talks to a network; 「確認」 only flips the in-memory PR.
import type { CommanderClient } from "./client.ts";
import type { BoardItem, CommanderApi, FeaturePhase } from "./commanderApi.ts";
import { makeFakePrApi, makePr } from "./prFake.ts";

const REPO = "https://github.com/KIT-DevelopersHub/dub-ecosystem/pull";

function item(n: number, title: string, phase: FeaturePhase, pr: number | null): BoardItem {
  const at = new Date(Date.now() - n * 7 * 60_000).toISOString();
  return {
    taskId: `demo-task-${n}`,
    featureId: `demo-feat-${n}`,
    title,
    featurePhase: phase,
    taskStatus: "doing",
    demoUrl: null,
    stagingUrl: phase.startsWith("staging") ? "https://staging.example.workers.dev" : null,
    prUrl: pr ? `${REPO}/${pr}` : null,
    prUrls: pr ? [`${REPO}/${pr}`] : [],
    latestRun: { id: `demo-run-${n}`, status: "succeeded", cwd: `/dub-worktrees/task-${n}`, createdAt: at },
    createdAt: at,
    updatedAt: at,
  };
}

export function makeDemo(): { api: CommanderApi; client: CommanderClient } {
  const pass = (name: string) => ({ name, state: "pass" as const, url: `${REPO}/checks?name=${name}`, required: true, labelGate: false });
  const gate = { name: "confirm-gate", state: "fail" as const, url: null, required: true, labelGate: true };
  const prs = makeFakePrApi([
    makePr({ number: 801, title: "使用量ダッシュボードを全メンバーに開放", labels: ["stagingへ"], checks: [pass("ci / typecheck"), pass("ci / test"), pass("ci / contract"), pass("staging / deploy"), pass("staging / verify-live"), gate] }),
    makePr({
      number: 802,
      title: "メール一覧の未読を太字に",
      labels: ["staging2へ"],
      checks: [
        pass("ci / typecheck"),
        pass("ci / contract"),
        pass("staging / deploy"),
        { name: "ci / test", state: "fail", url: `${REPO}/802/checks`, required: true, labelGate: false },
        { name: "visual-regression", state: "fail", url: `${REPO}/802/checks`, required: true, labelGate: false },
        gate,
      ],
    }),
    makePr({
      number: 803,
      title: "ガントの依存線",
      labels: [],
      checks: [pass("ci / typecheck"), { name: "ci / test", state: "pending", url: null, required: true, labelGate: false }, gate],
    }),
    makePr({ number: 804, title: "通知の既読同期", labels: ["stagingへ", "確認した"], checks: [pass("ci / typecheck"), pass("ci / test"), { ...gate, state: "pass" }] }),
  ]);
  const items = [
    item(1, "使用量ダッシュボードを全メンバーに開放", "staging_review", 801),
    item(2, "メール一覧の未読を太字に", "staging_review", 802),
    item(3, "ガントの依存線", "demo_review", 803),
    item(4, "通知の既読同期", "staging_review", 804),
    item(5, "PR なしのタスク", "demo_building", null),
  ];
  const unsupported = { ok: false as const, error: { status: 501, error: "demo" } };
  const api: CommanderApi = {
    prs,
    listFeatures: async () => [],
    createFeature: async () => unsupported,
    getFeature: async (id) => ({
      feature: { id, title: "", phase: items.find((i) => i.featureId === id)?.featurePhase ?? "demo_building", ledgerRef: null, createdAt: "", updatedAt: "" },
      allowedTransitions: [],
      transitions: [],
    }),
    transition: async () => unsupported,
    listRuns: async () => [],
    getRun: async () => null,
    listBoard: async () => items,
    createTask: async () => unsupported,
    updateTaskStatus: async () => unsupported,
    backfillTaskUrls: async () => ({ updated: 0 }),
    health: async () => true,
    listChats: async () => [],
    createChat: async (kind, title = "") => ({ id: "demo-chat", kind, title, createdAt: "", updatedAt: "" }),
    getChat: async () => null,
    renameChat: async () => null,
    deleteChat: async () => false,
    addChatMessage: async () => null,
    updateChatMessage: async () => null,
  };
  const client: CommanderClient = {
    startRun: async () => ({ runId: "demo-run" }),
    uploadImage: async () => ({ uploadId: "demo-upload" }),
    cancelRun: async () => {},
    health: async () => true,
    streamEvents: (_id, _onEvent, onClose) => {
      onClose();
      return () => {};
    },
  };
  return { api, client };
}
