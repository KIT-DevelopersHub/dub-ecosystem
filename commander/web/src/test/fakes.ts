// Shared test doubles for the board. A small in-memory CommanderApi + CommanderClient
// so component tests exercise the real orchestration (create → run → approve/reject)
// without a network.
import { vi } from "vitest";
import type { CommanderClient, DaemonRunEvent, StartRunOptions } from "../lib/client.ts";
import type {
  BoardItem,
  ChatKind,
  ChatMessage,
  ChatSession,
  CommanderApi,
  Feature,
  FeatureDetail,
  FeaturePhase,
  RunStatus,
} from "../lib/commanderApi.ts";
import { allowedTransitions } from "@dub/commander-phases";

export function makeBoardItem(over: Partial<BoardItem> & { runStatus?: RunStatus | null } = {}): BoardItem {
  const { runStatus, ...rest } = over;
  const now = "2026-09-18T00:00:00.000Z";
  return {
    taskId: rest.taskId ?? "task-1",
    featureId: rest.featureId ?? "feat-1",
    title: rest.title ?? "サンプルタスク",
    featurePhase: rest.featurePhase ?? "demo_building",
    taskStatus: rest.taskStatus ?? "todo",
    demoUrl: rest.demoUrl ?? null,
    stagingUrl: rest.stagingUrl ?? null,
    prUrl: rest.prUrl ?? null,
    latestRun:
      runStatus === null
        ? null
        : { id: rest.latestRun?.id ?? "run-1", status: runStatus ?? "running", cwd: "/repo/wt", createdAt: now },
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

export interface FakeApi extends CommanderApi {
  _items: BoardItem[];
  _phases: Record<string, FeaturePhase>;
  _sessions: ChatSession[];
  _messages: ChatMessage[];
}

export function makeFakeApi(initial: BoardItem[] = []): FakeApi {
  const items = [...initial];
  const phases: Record<string, FeaturePhase> = {};
  for (const i of items) phases[i.featureId] = i.featurePhase;
  let chatSeq = 0;

  const api: FakeApi = {
    _items: items,
    _phases: phases,
    _sessions: [],
    _messages: [],
    listChats: vi.fn(async (kind: ChatKind) =>
      api._sessions.filter((s) => s.kind === kind).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    ),
    createChat: vi.fn(async (kind: ChatKind, title = "") => {
      const now = new Date(Date.now() + chatSeq++).toISOString();
      const s: ChatSession = { id: `chat-${api._sessions.length + 1}`, kind, title, createdAt: now, updatedAt: now };
      api._sessions.unshift(s);
      return s;
    }),
    getChat: vi.fn(async (id: string) => {
      const session = api._sessions.find((s) => s.id === id);
      if (!session) return null;
      return { session, messages: api._messages.filter((m) => m.sessionId === id).sort((a, b) => a.seq - b.seq) };
    }),
    renameChat: vi.fn(async (id: string, title: string) => {
      const s = api._sessions.find((x) => x.id === id);
      if (!s) return null;
      s.title = title;
      s.updatedAt = new Date(Date.now() + chatSeq++).toISOString();
      return s;
    }),
    deleteChat: vi.fn(async (id: string) => {
      const before = api._sessions.length;
      api._sessions = api._sessions.filter((s) => s.id !== id);
      api._messages = api._messages.filter((m) => m.sessionId !== id);
      return api._sessions.length < before;
    }),
    addChatMessage: vi.fn(async (sessionId: string, input) => {
      const session = api._sessions.find((s) => s.id === sessionId);
      if (!session) return null;
      const seq = api._messages.filter((m) => m.sessionId === sessionId).length + 1;
      const msg: ChatMessage = {
        id: `msg-${api._messages.length + 1}`,
        sessionId,
        role: input.role,
        text: input.text,
        tools: input.tools ?? [],
        status: input.status ?? "done",
        seq,
        createdAt: new Date(Date.now() + chatSeq++).toISOString(),
      };
      api._messages.push(msg);
      session.updatedAt = msg.createdAt;
      return msg;
    }),
    updateChatMessage: vi.fn(async (_sessionId: string, messageId: string, input) => {
      const m = api._messages.find((x) => x.id === messageId);
      if (!m) return null;
      if (typeof input.text === "string") m.text = input.text;
      if (input.tools) m.tools = input.tools;
      if (input.status) m.status = input.status;
      return m;
    }),
    health: vi.fn(async () => true),
    listBoard: vi.fn(async () => api._items.map((i) => ({ ...i, featurePhase: phases[i.featureId] ?? i.featurePhase }))),
    createTask: vi.fn(async ({ title }: { title: string; ledgerRef?: string }) => {
      const feature: Feature = {
        id: `feat-${api._items.length + 1}`,
        title,
        phase: "demo_building",
        ledgerRef: null,
        createdAt: "t",
        updatedAt: "t",
      };
      phases[feature.id] = "demo_building";
      const task = { id: `task-${api._items.length + 1}`, featureId: feature.id, title, status: "todo" as const, createdAt: "t", updatedAt: "t" };
      api._items.unshift(
        makeBoardItem({ taskId: task.id, featureId: feature.id, title, runStatus: "running" }),
      );
      return { ok: true as const, value: { feature, task } };
    }),
    updateTaskStatus: vi.fn(async (id: string, status) => {
      const it = api._items.find((i) => i.taskId === id);
      if (it) it.taskStatus = status;
      return { ok: true as const, value: { id, featureId: it?.featureId ?? "", title: it?.title ?? "", status, createdAt: "t", updatedAt: "t" } };
    }),
    transition: vi.fn(async (id: string, to: FeaturePhase) => {
      phases[id] = to;
      const it = api._items.find((i) => i.featureId === id);
      if (it) it.featurePhase = to;
      return {
        ok: true as const,
        value: {
          feature: { id, title: "", phase: to, ledgerRef: null, createdAt: "t", updatedAt: "t" },
          transition: { id: "ptx", featureId: id, fromPhase: to, toPhase: to, approvedByUser: false, actor: "system" as const, note: null, createdAt: "t" },
        },
      };
    }),
    listFeatures: vi.fn(async () => []),
    createFeature: vi.fn(async () => ({ ok: false as const, error: { status: 0, error: "unused" } })),
    getFeature: vi.fn(async (id: string): Promise<FeatureDetail> => {
      const phase = phases[id] ?? "demo_building";
      return {
        feature: { id, title: "", phase, ledgerRef: null, createdAt: "t", updatedAt: "t" },
        allowedTransitions: allowedTransitions(phase).map((tr) => ({ ...tr })),
        transitions: [],
      };
    }),
    backfillTaskUrls: vi.fn(async () => ({ updated: 0 })),
    listRuns: vi.fn(async () => []),
    getRun: vi.fn(async (id: string) => ({
      run: { id, taskId: null, prompt: "元の指示", cwd: "/repo/wt", status: "succeeded" as const, exitCode: 0, createdAt: "t", updatedAt: "t" },
      events: [],
    })),
  };
  return api;
}

export function makeFakeClient(events: DaemonRunEvent[] = []): CommanderClient & { startRun: ReturnType<typeof vi.fn> } {
  const startRun = vi.fn(async (_p: string, _o?: StartRunOptions) => ({ runId: "run-new" }));
  return {
    startRun,
    cancelRun: vi.fn(async () => {}),
    health: vi.fn(async () => true),
    streamEvents: (_runId, onEvent, onClose) => {
      for (const ev of events) onEvent(ev);
      onClose();
      return () => {};
    },
  };
}
