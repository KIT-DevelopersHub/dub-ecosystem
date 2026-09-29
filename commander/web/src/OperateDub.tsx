// "Dubを操作する" — an operate console over the REAL Dub backend. Multi-session +
// persisted history (durable across restarts) via the shared ChatProvider. The operator
// states an intent; a planner run (background-capable) returns a JSON plan that renders as
// reviewable Operations. The SAFETY GATE lives here: read ops run freely; writes require
// an explicit confirm; destructive ops (delete/drop/truncate) require a typed confirmation.
// Only on confirm does the daemon spawn the executing command; its output is appended as a
// new assistant message.
import { useCallback, useState } from "react";
import type { ChatMessage } from "./lib/commanderApi.ts";
import { useChat } from "./lib/chatStore.tsx";
import { ChatComposer, MessageLog, SessionSidebar } from "./ChatUI.tsx";
import {
  buildExecPrompt,
  commandFor,
  D1_DB_NAME,
  DUB_OPERATE_CWD,
  isWrite,
  OPERATE_RUN_ARGS,
  parsePlan,
  PLAN_SYSTEM_PROMPT,
  type Operation,
} from "./lib/operateDub.ts";
import { btnPrimary, btnGhost, btnDanger, card, input, t } from "./lib/theme.ts";

const CONFIRM_PHRASE = "実行";

export function OperateDub() {
  const chat = useChat();
  const sessionId = chat.activeId("operate");
  const messages = sessionId ? chat.messages(sessionId) : [];
  const busy = sessionId ? chat.isRunning(sessionId) : false;

  const planIntent = useCallback(
    async (text: string) => {
      let sid = chat.activeId("operate");
      if (!sid) sid = (await chat.create("operate"))?.id ?? null;
      if (!sid) return;
      void chat.run("operate", sid, {
        userText: text,
        prompt: `${PLAN_SYSTEM_PROMPT}\n\n要望: ${text}`,
        opts: { cwd: DUB_OPERATE_CWD, args: OPERATE_RUN_ARGS },
      });
    },
    [chat],
  );

  const execOp = useCallback(
    (op: Operation) => {
      const sid = chat.activeId("operate");
      if (!sid) return;
      void chat.run("operate", sid, {
        prompt: buildExecPrompt(commandFor(op)),
        assistantSeed: `▶ 実行: ${op.title}\n\n`,
        opts: { cwd: DUB_OPERATE_CWD, args: OPERATE_RUN_ARGS },
      });
    },
    [chat],
  );

  // An assistant message whose text parses to a plan renders as Operation cards; every
  // other message (intents, execution outputs) renders as a normal bubble.
  const renderBody = useCallback(
    (msg: ChatMessage) => {
      if (msg.role !== "assistant") return undefined;
      const parsed = parsePlan(msg.text);
      if (!parsed.ok || parsed.plan.ops.length === 0) return undefined;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space3, width: "100%" }} data-testid="operate-plan">
          {parsed.plan.summary && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7 }}>{parsed.plan.summary}</p>}
          {parsed.plan.ops.map((op) => (
            <OpCard key={op.id} op={op} onExecute={execOp} />
          ))}
        </div>
      );
    },
    [execOp],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
      <div style={{ ...card, background: t.sunken, borderColor: t.borderStrong }}>
        <p style={{ margin: 0, fontSize: 13, color: t.textMuted, lineHeight: 1.7 }}>
          Dub の <b>本番バックエンド</b>を自然言語で操作（D1 / API を additive に）。まず<b>計画</b>を作り、
          <b>各操作を確認してから実行</b>。読み取りはそのまま、
          <b style={{ color: t.warning }}>書き込みは要確認</b>、
          <b style={{ color: t.danger }}>削除系は「{CONFIRM_PHRASE}」入力</b>が必要です。 対象 D1:{" "}
          <code style={{ fontSize: 12 }}>{D1_DB_NAME}</code>
        </p>
      </div>

      <div style={{ display: "flex", gap: t.space4, alignItems: "stretch" }}>
        <SessionSidebar kind="operate" />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: t.space4 }}>
          <MessageLog
            messages={messages}
            renderBody={renderBody}
            emptyState={
              <>
                <p style={{ marginBottom: t.space2 }}>やりたいことを書くと、実行前に確認できる計画を作ります。</p>
                <p style={{ fontSize: 12 }}>例: 「サンプルユーザーを5人本番に入れて」「users の件数を教えて」</p>
              </>
            }
          />
          <ChatComposer
            sessionId={sessionId ?? "none"}
            placeholder="やりたいことを書く（例: サンプルユーザーを5人入れて）"
            disabled={busy}
            busy={busy}
            sendLabel="計画を作成"
            onSend={(text) => void planIntent(text)}
          />
        </div>
      </div>
    </div>
  );
}

type OpPhase = "idle" | "confirming" | "started";

function OpCard({ op, onExecute }: { op: Operation; onExecute: (op: Operation) => void }) {
  const [phase, setPhase] = useState<OpPhase>("idle");
  const [confirmText, setConfirmText] = useState("");

  const write = isWrite(op);
  const command = commandFor(op);

  const fire = () => {
    onExecute(op);
    setPhase("started");
    setConfirmText("");
  };

  const kindLabel = op.kind === "d1_read" ? "読み取り" : op.kind === "d1_write" ? "書き込み" : "API";
  const kindColor = op.kind === "d1_read" ? t.success : op.destructive ? t.danger : t.warning;

  return (
    <div
      style={{ ...card, borderColor: op.destructive ? t.danger : t.border }}
      data-testid="operate-op"
      data-op-kind={op.kind}
      data-op-destructive={op.destructive ? "1" : "0"}
    >
      <div style={{ display: "flex", alignItems: "center", gap: t.space2, marginBottom: t.space2 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: kindColor, borderRadius: 6, padding: `2px ${t.space2}` }}>
          {kindLabel}
        </span>
        {op.destructive && <span style={{ fontSize: 11, fontWeight: 700, color: t.danger }}>削除系（要注意）</span>}
        <span style={{ fontSize: 14, fontWeight: 600 }}>{op.title}</span>
      </div>

      {op.note && <p style={{ margin: `0 0 ${t.space2}`, fontSize: 12, color: t.textMuted }}>{op.note}</p>}

      <pre
        data-testid="operate-op-command"
        style={{
          margin: `0 0 ${t.space3}`,
          padding: t.space3,
          background: t.sunken,
          border: `1px solid ${t.border}`,
          borderRadius: "var(--dub-radius-sm, 8px)",
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          overflowX: "auto",
        }}
      >
        {command}
      </pre>

      {phase === "started" && (
        <div style={{ fontSize: 13, color: t.textMuted }} data-testid="operate-op-started">
          実行を開始しました。結果は下のメッセージに表示されます。{" "}
          <button type="button" style={{ ...btnGhost, padding: "2px 8px" }} onClick={() => setPhase("idle")}>
            もう一度
          </button>
        </div>
      )}

      {phase === "idle" && !write && (
        <button type="button" style={btnGhost} data-testid="operate-op-run" onClick={fire}>
          実行（読み取り）
        </button>
      )}

      {phase === "idle" && write && (
        <button
          type="button"
          style={op.destructive ? btnDanger : btnPrimary}
          data-testid="operate-op-run"
          onClick={() => setPhase("confirming")}
        >
          本番に実行…
        </button>
      )}

      {phase === "confirming" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: t.space2,
            padding: t.space3,
            border: `1px solid ${op.destructive ? t.danger : t.warning}`,
            borderRadius: "var(--dub-radius-sm, 8px)",
            background: t.sunken,
          }}
          data-testid="operate-op-confirm-panel"
        >
          <span style={{ fontSize: 13, color: op.destructive ? t.danger : t.warning, fontWeight: 600 }}>
            {op.destructive
              ? `この操作はデータを失う可能性があります。実行するには「${CONFIRM_PHRASE}」と入力してください。`
              : "この操作は本番に書き込みます。実行してよろしいですか？"}
          </span>
          {op.destructive && (
            <input
              data-testid="operate-op-confirm-input"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_PHRASE}
              style={{ ...input, maxWidth: 220 }}
            />
          )}
          <div style={{ display: "flex", gap: t.space2 }}>
            <button
              type="button"
              style={btnGhost}
              data-testid="operate-op-cancel"
              onClick={() => {
                setPhase("idle");
                setConfirmText("");
              }}
            >
              キャンセル
            </button>
            <button
              type="button"
              style={{ ...btnDanger, opacity: op.destructive && confirmText.trim() !== CONFIRM_PHRASE ? 0.5 : 1 }}
              data-testid="operate-op-confirm"
              disabled={op.destructive && confirmText.trim() !== CONFIRM_PHRASE}
              onClick={fire}
            >
              実行する
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
