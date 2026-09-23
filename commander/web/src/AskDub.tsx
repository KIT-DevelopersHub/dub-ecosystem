// "Dubに聞く" — a Q&A chat over the dub-ecosystem codebase. Distinct from the task
// board (投入して作らせる): here the operator ASKS ("カレンダーアプリはどこ?" /
// "予約送信の仕組みは?") and a read-only claude answers by inspecting the real repo.
//
// It reuses the existing exec bridge: each question is a run with
// cwd=DUB_ECOSYSTEM_CWD and a read-only Q&A prompt, streamed over SSE. Follow-up
// questions re-inject the prior transcript so the thread keeps context (P0). The
// transcript is kept in memory + mirrored to localStorage so a reload keeps history.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpCommanderClient, type CommanderClient } from "./lib/client.ts";
import {
  buildAskPrompt,
  buildTranscript,
  DUB_ECOSYSTEM_CWD,
  parseClaudeEvent,
} from "./lib/askDub.ts";
import { btnPrimary, btnGhost, card, input, t } from "./lib/theme.ts";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Live tool-activity lines (assistant only), shown while thinking. */
  tools: string[];
  status: "streaming" | "done" | "error";
}

const STORAGE_KEY = "commander.askDub.history.v1";

function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    // Never resurrect a "streaming" bubble from a previous session.
    return parsed.map((m) => (m.status === "streaming" ? { ...m, status: "done" } : m));
  } catch {
    return [];
  }
}

function saveHistory(messages: ChatMessage[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    /* private mode / quota — history is a convenience, not load-bearing */
  }
}

const defaultClient = new HttpCommanderClient();

const SAMPLE_QUESTIONS = [
  "カレンダーアプリはどこにある?",
  "予約送信(スケジュール投稿)の仕組みは?",
  "認証(ログイン)はどう実装されている?",
];

interface AskDubProps {
  client?: CommanderClient;
  /** Skip localStorage seeding (tests). */
  seed?: ChatMessage[];
}

export function AskDub({ client = defaultClient, seed }: AskDubProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => seed ?? loadHistory());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => saveHistory(messages), [messages]);
  useEffect(() => {
    const el = scrollRef.current;
    // jsdom has no scrollTo; guard so tests (and any non-DOM env) don't throw.
    if (el && typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);
  useEffect(() => () => unsubRef.current?.(), []);

  const priorTurns = useMemo(
    () => messages.map((m) => ({ role: m.role, text: m.text })),
    [messages],
  );

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;
      setBusy(true);
      setDraft("");

      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        text: q,
        tools: [],
        status: "done",
      };
      const assistantId = `a-${Date.now()}`;
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        text: "",
        tools: [],
        status: "streaming",
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);

      const transcript = buildTranscript(priorTurns);
      const prompt = buildAskPrompt(q, transcript);

      const patch = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));

      try {
        const { runId } = await client.startRun(prompt, { cwd: DUB_ECOSYSTEM_CWD });
        let acc = "";
        let sawResult = false;
        unsubRef.current = client.streamEvents(
          runId,
          (ev) => {
            if (ev.type === "status" && (ev.status === "succeeded" || ev.status === "failed")) {
              patch((m) => ({ ...m, status: ev.status === "failed" ? "error" : "done" }));
              return;
            }
            for (const d of parseClaudeEvent(ev)) {
              if (d.kind === "result") {
                sawResult = true;
                acc = d.text;
                patch((m) => ({ ...m, text: acc }));
              } else if (d.kind === "text") {
                if (!sawResult) {
                  acc += d.text;
                  patch((m) => ({ ...m, text: acc }));
                }
              } else if (d.kind === "tool") {
                patch((m) => ({ ...m, tools: [...m.tools, d.label] }));
              }
            }
          },
          () => {
            setBusy(false);
            patch((m) => ({
              ...m,
              status: m.status === "streaming" ? (m.text ? "done" : "error") : m.status,
              text: m.text || (m.status === "error" ? "" : "（回答が空でした）"),
            }));
          },
        );
      } catch (err) {
        patch((m) => ({
          ...m,
          status: "error",
          text: `起動に失敗しました: ${(err as Error).message}（daemon 4319 が起動しているか確認してください）`,
        }));
        setBusy(false);
      }
    },
    [busy, client, priorTurns],
  );

  const clearHistory = useCallback(() => {
    unsubRef.current?.();
    setMessages([]);
    setBusy(false);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: t.space3,
        }}
      >
        <p style={{ margin: 0, fontSize: 13, color: t.textMuted }}>
          dub-ecosystem のコードを調べて答える Q&A チャット（読み取り専用）。
          cwd: <code style={{ fontSize: 12 }}>{DUB_ECOSYSTEM_CWD}</code>
        </p>
        {messages.length > 0 && (
          <button type="button" style={btnGhost} onClick={clearHistory} data-testid="askdub-clear">
            履歴をクリア
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        data-testid="askdub-log"
        style={{
          ...card,
          minHeight: 320,
          maxHeight: "56vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: t.space4,
          background: t.sunken,
        }}
      >
        {messages.length === 0 ? (
          <div style={{ margin: "auto", textAlign: "center", color: t.textMuted }}>
            <p style={{ marginBottom: t.space3 }}>Dub について質問してみてください。例:</p>
            <div style={{ display: "flex", flexDirection: "column", gap: t.space2, alignItems: "center" }}>
              {SAMPLE_QUESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  style={{ ...btnGhost, fontWeight: 400 }}
                  onClick={() => ask(s)}
                  data-testid="askdub-sample"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} msg={m} />)
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
        style={{ display: "flex", gap: t.space3, alignItems: "flex-end" }}
      >
        <textarea
          data-testid="askdub-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter to send, Shift+Enter for newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(draft);
            }
          }}
          placeholder="〇〇はどうなってる? △△機能はどこ? と聞く（Enterで送信 / Shift+Enterで改行）"
          rows={2}
          style={{ ...input, resize: "vertical", fontFamily: "inherit" }}
          disabled={busy}
        />
        <button
          type="submit"
          style={{ ...btnPrimary, whiteSpace: "nowrap", opacity: busy || !draft.trim() ? 0.5 : 1 }}
          disabled={busy || !draft.trim()}
          data-testid="askdub-send"
        >
          {busy ? "調査中…" : "聞く"}
        </button>
      </form>
    </div>
  );
}

function Bubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div
      data-testid={`askdub-msg-${msg.role}`}
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "88%",
        display: "flex",
        flexDirection: "column",
        gap: t.space2,
      }}
    >
      <div
        style={{
          background: isUser ? t.primary : t.surface,
          color: isUser ? "#fff" : t.text,
          border: isUser ? "none" : `1px solid ${t.border}`,
          borderRadius: t.radius,
          padding: `${t.space3} ${t.space4}`,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: 1.6,
          fontSize: 14,
        }}
      >
        {msg.text ? (
          msg.text
        ) : msg.status === "streaming" ? (
          <span style={{ color: t.textMuted }}>調査中…</span>
        ) : msg.status === "error" ? (
          <span style={{ color: t.danger }}>回答を取得できませんでした。</span>
        ) : (
          ""
        )}
        {msg.status === "streaming" && msg.text && (
          <span style={{ color: t.textMuted }}> ▍</span>
        )}
      </div>

      {!isUser && msg.tools.length > 0 && (
        <details style={{ fontSize: 12, color: t.textMuted }}>
          <summary style={{ cursor: "pointer" }}>
            調べたもの {msg.status === "streaming" ? `(${msg.tools.length}件・進行中)` : `(${msg.tools.length}件)`}
          </summary>
          <ul style={{ margin: `${t.space2} 0 0`, paddingLeft: t.space5 }}>
            {msg.tools.slice(-30).map((tl, i) => (
              <li key={i} style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
                {tl}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
