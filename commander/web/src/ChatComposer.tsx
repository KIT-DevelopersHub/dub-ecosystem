// Chat-style capture bar — the board's headline entry (design §2 「受信」). The operator
// types a line the way they'd message an assistant; Commander decides *locally* (no claude
// spawn — ＄0 / 非力PC) whether it's a task or just chat:
//   - task      → register it as an UNREQUESTED task (未依頼) and reply "取り掛かりますか?"
//                 with an 「AIに依頼する」 button. The run starts ONLY when that button is
//                 pressed — never on typing.
//   - chat      → a local reply, no task, no run.
//   - ambiguous → ask "これはタスク？" with [タスクとして登録] / [ただの質問] buttons.
// This is the fix for "打つとそのまま実行してしまう": capture and execution are now two
// deliberate steps.
import { useEffect, useRef, useState } from "react";
import { classifyIntent } from "./lib/intent.ts";
import { btnGhost, btnPrimary, input, t } from "./lib/theme.ts";

/** Result of proposing a task to the board (create-only, no run). */
export interface ProposeResult {
  taskId: string;
}

export interface ChatComposerProps {
  /** Register a task in the 未依頼 (queued) lane — creates the task, does NOT run it. */
  onPropose: (v: { title: string; prompt: string; cwd: string }) => Promise<ProposeResult | null>;
  /** Start the run for an already-registered task (the 「AIに依頼する」 action). */
  onRequestRun: (taskId: string, prompt: string, cwd: string) => Promise<void>;
  /** Default worktree for chat-captured tasks (first pin / suggestion). */
  defaultCwd?: string;
}

type Msg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string }
  // A registered-but-unrequested task awaiting the 「AIに依頼する」 press.
  | { id: string; role: "proposal"; text: string; taskId: string; prompt: string; cwd: string; requested: boolean }
  // An unclear line: offer to register it or treat it as a question.
  | { id: string; role: "ask"; text: string; prompt: string; cwd: string; resolved: boolean };

let seq = 0;
const nextId = () => `m${++seq}`;

export function ChatComposer({ onPropose, onRequestRun, defaultCwd = "" }: ChatComposerProps) {
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    // scrollTo is absent under jsdom — guard so tests (and odd hosts) don't throw.
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight });
  }, [msgs]);

  const push = (m: Msg) => setMsgs((prev) => [...prev, m]);

  // Register a task (create-only) and reply with the 「AIに依頼する」 affordance.
  const propose = async (prompt: string, cwd: string, title: string) => {
    setBusy(true);
    try {
      const res = await onPropose({ title, prompt, cwd });
      if (!res) {
        push({ id: nextId(), role: "assistant", text: "タスクの登録に失敗しました（service 未起動の可能性）。" });
        return;
      }
      push({
        id: nextId(),
        role: "proposal",
        text: `「${title}」をタスクとして登録しました（未依頼）。このタスクに取り掛かりますか？`,
        taskId: res.taskId,
        prompt,
        cwd,
        requested: false,
      });
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const raw = text.trim();
    if (raw === "" || busy) return;
    setText("");
    push({ id: nextId(), role: "user", text: raw });
    const intent = classifyIntent(raw);
    const cwd = defaultCwd;

    if (intent.kind === "task") {
      await propose(raw, cwd, intent.title);
    } else if (intent.kind === "chat") {
      push({
        id: nextId(),
        role: "assistant",
        text: "了解です（これはタスクとしては登録していません）。作業を頼むときは「〜を作って/直して」のように書いてください。",
      });
    } else {
      push({
        id: nextId(),
        role: "ask",
        text: "これはタスクですか？（登録すると「AIに依頼する」で実行できます）",
        prompt: raw,
        cwd,
        resolved: false,
      });
    }
  };

  // 「AIに依頼する」: start the run for a registered task, then mark the bubble done.
  const requestRun = async (m: Extract<Msg, { role: "proposal" }>) => {
    setBusy(true);
    try {
      await onRequestRun(m.taskId, m.prompt, m.cwd);
      setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...m, requested: true } : x)));
      push({ id: nextId(), role: "assistant", text: `「${m.prompt}」の実行を開始しました。走行中レーンで進捗を確認できます。` });
    } finally {
      setBusy(false);
    }
  };

  const resolveAsk = async (m: Extract<Msg, { role: "ask" }>, asTask: boolean) => {
    setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...m, resolved: true } : x)));
    if (asTask) {
      const intent = classifyIntent(m.prompt);
      await propose(m.prompt, m.cwd, intent.title || m.prompt.slice(0, 48));
    } else {
      push({ id: nextId(), role: "assistant", text: "質問として扱いました（タスクは登録していません）。" });
    }
  };

  return (
    <section
      data-testid="chat-composer"
      aria-label="タスク投入チャット"
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: t.radius,
        background: t.surface,
        padding: t.space4,
        marginBottom: t.space5,
        display: "flex",
        flexDirection: "column",
        gap: t.space3,
      }}
    >
      {msgs.length > 0 && (
        <div
          ref={scrollRef}
          data-testid="chat-messages"
          style={{ display: "flex", flexDirection: "column", gap: t.space3, maxHeight: 260, overflowY: "auto" }}
        >
          {msgs.map((m) => (
            <ChatBubble key={m.id} msg={m} busy={busy} onRequestRun={requestRun} onResolveAsk={resolveAsk} />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: t.space2, alignItems: "flex-end" }}>
        <textarea
          data-testid="chat-input"
          aria-label="chat-input"
          placeholder="やってほしいことを書く（例: 俺の自己紹介ページを作って）。タスクと判定したら登録し、実行は「AIに依頼する」を押してから。"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter to send, Shift+Enter for a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          style={{ ...input, minHeight: 44, resize: "vertical", flex: 1 }}
        />
        <button
          type="button"
          data-testid="chat-send"
          onClick={() => void send()}
          disabled={busy || text.trim() === ""}
          style={{ ...btnPrimary, opacity: busy || text.trim() === "" ? 0.5 : 1, whiteSpace: "nowrap" }}
        >
          送信
        </button>
      </div>
    </section>
  );
}

function ChatBubble({
  msg,
  busy,
  onRequestRun,
  onResolveAsk,
}: {
  msg: Msg;
  busy: boolean;
  onRequestRun: (m: Extract<Msg, { role: "proposal" }>) => void;
  onResolveAsk: (m: Extract<Msg, { role: "ask" }>, asTask: boolean) => void;
}) {
  const mine = msg.role === "user";
  return (
    <div
      data-testid={`chat-msg-${msg.role}`}
      style={{
        alignSelf: mine ? "flex-end" : "flex-start",
        maxWidth: "85%",
        background: mine ? t.primary : t.sunken,
        color: mine ? "#fff" : t.text,
        border: mine ? "none" : `1px solid ${t.border}`,
        borderRadius: t.radius,
        padding: `${t.space2} ${t.space3}`,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.text}</div>

      {msg.role === "proposal" && !msg.requested && (
        <button
          type="button"
          data-testid={`chat-request-run-${msg.taskId}`}
          onClick={() => onRequestRun(msg)}
          disabled={busy}
          style={{ ...btnPrimary, marginTop: t.space2 }}
        >
          🤖 AIに依頼する
        </button>
      )}
      {msg.role === "proposal" && msg.requested && (
        <div style={{ marginTop: t.space2, fontSize: 12, color: t.success }}>依頼済み — 実行中</div>
      )}

      {msg.role === "ask" && !msg.resolved && (
        <div style={{ display: "flex", gap: t.space2, marginTop: t.space2, flexWrap: "wrap" }}>
          <button
            type="button"
            data-testid="chat-ask-yes"
            onClick={() => onResolveAsk(msg, true)}
            disabled={busy}
            style={btnPrimary}
          >
            タスクとして登録
          </button>
          <button
            type="button"
            data-testid="chat-ask-no"
            onClick={() => onResolveAsk(msg, false)}
            disabled={busy}
            style={btnGhost}
          >
            ただの質問（実行しない）
          </button>
        </div>
      )}
    </div>
  );
}
