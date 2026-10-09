// Shared chat store for the "Dubに聞く" / "Dubを操作" consoles. Mounted ONCE at the App
// root (see App.tsx) so it outlives tab/session switches: a run started in one session
// keeps streaming in the background while the operator views another session or the
// board. History is persisted to commander-service (D1) — durable across restarts;
// "履歴をクリア" physically deletes a session. Drafts are handled per-session in the
// Composer via localStorage (see ChatComposer), not here, so typing never re-renders
// the message list.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { HttpCommanderApi, type ChatKind, type ChatMessage, type ChatSession, type CommanderApi } from "./commanderApi.ts";
import { HttpCommanderClient, type CommanderClient, type StartRunOptions } from "./client.ts";
import { parseClaudeEvent } from "./askDub.ts";

/** How a run's stream maps onto the assistant message: a plain answer, an operate plan,
 *  or a single op execution result. Used only for the assistant seed text. */
export interface RunSpec {
  /** Optional user message to record before the run (the question / intent). */
  userText?: string;
  /** The full prompt sent to claude. */
  prompt: string;
  /** cwd + per-run CLI args (e.g. --disallowedTools Task). */
  opts: StartRunOptions;
  /** Prefixed onto the assistant message text (e.g. "▶ 実行: <cmd>\n"). */
  assistantSeed?: string;
}

export interface ChatStore {
  ready: boolean;
  sessions: (kind: ChatKind) => ChatSession[];
  activeId: (kind: ChatKind) => string | null;
  messages: (sessionId: string) => ChatMessage[];
  isRunning: (sessionId: string) => boolean;
  select: (kind: ChatKind, id: string) => void;
  create: (kind: ChatKind) => Promise<ChatSession | null>;
  remove: (kind: ChatKind, id: string) => Promise<void>;
  /** Give a session an operator-chosen name (optimistic; rolls back on failure).
   *  Returns false for a rejected (empty) title or a failed write. */
  rename: (kind: ChatKind, id: string, title: string) => Promise<boolean>;
  /** Start a run in a session; streams into a persisted assistant message. */
  run: (kind: ChatKind, sessionId: string, spec: RunSpec) => Promise<ChatMessage | null>;
  /** Persist a finished assistant message the console wrote itself (no run). */
  note: (sessionId: string, text: string) => Promise<ChatMessage | null>;
}

const Ctx = createContext<ChatStore | null>(null);

const KINDS: ChatKind[] = ["ask", "operate"];
const titleFrom = (text: string): string => text.trim().replace(/\s+/g, " ").slice(0, 40) || "新しいチャット";

/** Max length of an operator-typed name (auto-titles stay at 40). */
export const TITLE_MAX = 60;
/** Trim + collapse whitespace; "" means "reject this rename". */
export const normalizeTitle = (raw: string): string => raw.trim().replace(/\s+/g, " ").slice(0, TITLE_MAX);

export function ChatProvider({
  client = defaultClient,
  api = defaultApi,
  children,
}: {
  client?: CommanderClient;
  api?: CommanderApi;
  children: ReactNode;
}) {
  const [sessionsByKind, setSessionsByKind] = useState<Record<ChatKind, ChatSession[]>>({ ask: [], operate: [] });
  const [activeByKind, setActiveByKind] = useState<Record<ChatKind, string | null>>({ ask: null, operate: null });
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [runningSessions, setRunningSessions] = useState<Record<string, boolean>>({});
  const [ready, setReady] = useState(false);

  const loadedMsgs = useRef<Set<string>>(new Set());
  const unsubs = useRef<Map<string, () => void>>(new Map());
  // Current title per session id, kept in a ref so `run()` sees it without waiting for a
  // re-render: a session created moments earlier (create → first send) is not in the
  // caller's `sessionsByKind` snapshot yet. This is what gates the auto-title.
  const titles = useRef<Map<string, string>>(new Map());

  // Hydrate the session lists for both kinds on mount (durable history from D1).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [ask, operate] = await Promise.all([api.listChats("ask"), api.listChats("operate")]);
        if (!alive) return;
        // Non-destructive merge: a session created locally BEFORE hydration finished (a
        // race with the first send) must survive and stay active — keep locally-known
        // sessions first, append server ones not already present, and never clobber an
        // already-selected active id back to null.
        const merge = (local: ChatSession[], server: ChatSession[]): ChatSession[] => {
          const seen = new Set(local.map((s) => s.id));
          const fresh = server.filter((s) => !seen.has(s.id));
          // Seed the title cache from D1 so a name given in an earlier visit still blocks
          // the auto-title. Locally-known sessions already hold the newer value.
          for (const s of fresh) titles.current.set(s.id, s.title);
          return [...local, ...fresh];
        };
        setSessionsByKind((prev) => ({ ask: merge(prev.ask, ask), operate: merge(prev.operate, operate) }));
        // Restore the session the operator was last on (so their draft shows), falling
        // back to a locally-created active id, then the newest server session.
        const pick = (server: ChatSession[], k: ChatKind, prevActive: string | null): string | null => {
          if (prevActive) return prevActive;
          const stored = loadActiveId(k);
          if (stored && server.some((s) => s.id === stored)) return stored;
          return server[0]?.id ?? null;
        };
        setActiveByKind((prev) => ({
          ask: pick(ask, "ask", prev.ask),
          operate: pick(operate, "operate", prev.operate),
        }));
      } catch {
        /* service down — the UI shows an empty state and can still create sessions */
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
      for (const un of unsubs.current.values()) un();
    };
  }, [api]);

  const loadMessages = useCallback(
    async (sessionId: string) => {
      if (loadedMsgs.current.has(sessionId)) return;
      loadedMsgs.current.add(sessionId);
      try {
        const got = await api.getChat(sessionId);
        if (got) setMessagesBySession((prev) => ({ ...prev, [sessionId]: got.messages }));
      } catch {
        loadedMsgs.current.delete(sessionId);
      }
    },
    [api],
  );

  // Load messages for whichever session is active in each kind.
  useEffect(() => {
    for (const k of KINDS) {
      const id = activeByKind[k];
      if (id) void loadMessages(id);
    }
  }, [activeByKind, loadMessages]);

  const patchMessage = useCallback((sessionId: string, msgId: string, fn: (m: ChatMessage) => ChatMessage) => {
    setMessagesBySession((prev) => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? []).map((m) => (m.id === msgId ? fn(m) : m)),
    }));
  }, []);

  const appendMessage = useCallback((sessionId: string, msg: ChatMessage) => {
    setMessagesBySession((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), msg] }));
  }, []);

  /** Write a title to both the render state and the ref the auto-title gate reads. */
  const applyTitle = useCallback((kind: ChatKind, id: string, title: string) => {
    titles.current.set(id, title);
    setSessionsByKind((prev) => ({
      ...prev,
      [kind]: prev[kind].map((s) => (s.id === id ? { ...s, title } : s)),
    }));
  }, []);

  const create = useCallback(
    async (kind: ChatKind): Promise<ChatSession | null> => {
      try {
        const session = await api.createChat(kind);
        loadedMsgs.current.add(session.id);
        titles.current.set(session.id, session.title);
        setMessagesBySession((prev) => ({ ...prev, [session.id]: [] }));
        setSessionsByKind((prev) => ({ ...prev, [kind]: [session, ...prev[kind]] }));
        setActiveByKind((prev) => ({ ...prev, [kind]: session.id }));
        saveActiveId(kind, session.id);
        return session;
      } catch {
        return null;
      }
    },
    [api],
  );

  const select = useCallback((kind: ChatKind, id: string) => {
    setActiveByKind((prev) => ({ ...prev, [kind]: id }));
    saveActiveId(kind, id);
  }, []);

  const rename = useCallback(
    async (kind: ChatKind, id: string, raw: string): Promise<boolean> => {
      const title = normalizeTitle(raw);
      if (!title) return false; // empty name = keep the current one
      const previous = titles.current.get(id) ?? "";
      if (title === previous) return true;
      applyTitle(kind, id, title); // optimistic
      try {
        const saved = await api.renameChat(id, title);
        if (!saved) throw new Error("rename failed");
        return true;
      } catch {
        applyTitle(kind, id, previous); // rollback
        return false;
      }
    },
    [api, applyTitle],
  );

  const remove = useCallback(
    async (kind: ChatKind, id: string) => {
      unsubs.current.get(id)?.();
      unsubs.current.delete(id);
      await api.deleteChat(id).catch(() => {});
      try {
        localStorage.removeItem(draftKey(id));
      } catch {
        /* ignore */
      }
      loadedMsgs.current.delete(id);
      titles.current.delete(id);
      setMessagesBySession((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSessionsByKind((prev) => {
        const rest = prev[kind].filter((s) => s.id !== id);
        setActiveByKind((a) => {
          if (a[kind] !== id) return a;
          const next = rest[0]?.id ?? null;
          saveActiveId(kind, next);
          return { ...a, [kind]: next };
        });
        return { ...prev, [kind]: rest };
      });
    },
    [api],
  );

  const setRunning = useCallback((sessionId: string, running: boolean) => {
    setRunningSessions((prev) => ({ ...prev, [sessionId]: running }));
  }, []);

  const bumpSessionToTop = useCallback((kind: ChatKind, sessionId: string) => {
    setSessionsByKind((prev) => {
      const found = prev[kind].find((s) => s.id === sessionId);
      if (!found) return prev;
      const rest = prev[kind].filter((s) => s.id !== sessionId);
      return { ...prev, [kind]: [{ ...found, updatedAt: new Date().toISOString() }, ...rest] };
    });
  }, []);

  const run = useCallback(
    async (kind: ChatKind, sessionId: string, spec: RunSpec): Promise<ChatMessage | null> => {
      setRunning(sessionId, true);
      bumpSessionToTop(kind, sessionId);

      // Record the user message + auto-title the session from the first one — but ONLY
      // while it is still unnamed. A name the operator typed (this visit or a previous
      // one, see the hydration seed) must never be overwritten by the first question.
      if (spec.userText != null && spec.userText.trim()) {
        const userMsg = await api.addChatMessage(sessionId, { role: "user", text: spec.userText, status: "done" });
        if (userMsg) appendMessage(sessionId, userMsg);
        if (!(titles.current.get(sessionId) ?? "").trim()) {
          const title = titleFrom(spec.userText);
          applyTitle(kind, sessionId, title);
          void api.renameChat(sessionId, title).catch(() => {});
        }
      }

      // Create the streaming assistant message up front (persisted), then stream into it.
      const seed = spec.assistantSeed ?? "";
      const asst = await api.addChatMessage(sessionId, { role: "assistant", text: seed, tools: [], status: "streaming" });
      if (!asst) {
        setRunning(sessionId, false);
        return null;
      }
      appendMessage(sessionId, asst);

      return new Promise<ChatMessage | null>((resolve) => {
        const finalize = (text: string, tools: string[], status: "done" | "error") => {
          patchMessage(sessionId, asst.id, (m) => ({ ...m, text, tools, status }));
          void api.updateChatMessage(sessionId, asst.id, { text, tools, status }).catch(() => {});
          setRunning(sessionId, false);
          unsubs.current.delete(sessionId);
          resolve({ ...asst, text, tools, status });
        };

        client
          .startRun(spec.prompt, spec.opts)
          .then(({ runId }) => {
            let acc = seed;
            const tools: string[] = [];
            let sawResult = false;
            let failed = false;
            const unsub = client.streamEvents(
              runId,
              (ev) => {
                if (ev.type === "status" && ev.status === "failed") failed = true;
                for (const d of parseClaudeEvent(ev)) {
                  if (d.kind === "result") {
                    sawResult = true;
                    acc = seed + d.text;
                    patchMessage(sessionId, asst.id, (m) => ({ ...m, text: acc }));
                  } else if (d.kind === "text" && !sawResult) {
                    acc += d.text;
                    patchMessage(sessionId, asst.id, (m) => ({ ...m, text: acc }));
                  } else if (d.kind === "tool") {
                    tools.push(d.label);
                    patchMessage(sessionId, asst.id, (m) => ({ ...m, tools: [...tools] }));
                  }
                }
              },
              () => finalize(acc || seed, tools, failed ? "error" : "done"),
            );
            unsubs.current.set(sessionId, unsub);
          })
          .catch((err: unknown) => {
            finalize(`${seed}起動に失敗しました: ${(err as Error).message}（daemon 4319 を確認）`, [], "error");
          });
      });
    },
    [api, client, appendMessage, applyTitle, patchMessage, setRunning, bumpSessionToTop],
  );

  const note = useCallback(
    async (sessionId: string, text: string): Promise<ChatMessage | null> => {
      const msg = await api.addChatMessage(sessionId, { role: "assistant", text, tools: [], status: "done" }).catch(() => null);
      if (msg) appendMessage(sessionId, msg);
      return msg;
    },
    [api, appendMessage],
  );

  const store: ChatStore = useMemo(
    () => ({
      ready,
      sessions: (kind) => sessionsByKind[kind],
      activeId: (kind) => activeByKind[kind],
      messages: (sessionId) => messagesBySession[sessionId] ?? [],
      isRunning: (sessionId) => runningSessions[sessionId] === true,
      select,
      create,
      remove,
      rename,
      run,
      note,
    }),
    [ready, sessionsByKind, activeByKind, messagesBySession, runningSessions, select, create, remove, rename, run, note],
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useChat(): ChatStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useChat must be used within <ChatProvider>");
  return ctx;
}

// --- per-session draft persistence (Task 3) --------------------------------------
export const draftKey = (sessionId: string): string => `commander.draft.${sessionId}`;

export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}
export function saveDraft(sessionId: string, text: string): void {
  try {
    if (text) localStorage.setItem(draftKey(sessionId), text);
    else localStorage.removeItem(draftKey(sessionId));
  } catch {
    /* private mode / quota — draft is a convenience */
  }
}

// Remember which session the operator was last on per kind, so a reload restores it
// (and therefore its draft) instead of jumping to the newest session.
const activeKey = (kind: ChatKind): string => `commander.activeChat.${kind}`;
function loadActiveId(kind: ChatKind): string | null {
  try {
    return localStorage.getItem(activeKey(kind));
  } catch {
    return null;
  }
}
function saveActiveId(kind: ChatKind, id: string | null): void {
  try {
    if (id) localStorage.setItem(activeKey(kind), id);
    else localStorage.removeItem(activeKey(kind));
  } catch {
    /* ignore */
  }
}

const defaultClient: CommanderClient = new HttpCommanderClient();
const defaultApi: CommanderApi = new HttpCommanderApi();
