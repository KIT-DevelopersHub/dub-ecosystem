// "Dubを操作する" — an operate console over the REAL Dub backend. Multi-session +
// persisted history (durable across restarts) via the shared ChatProvider. The operator
// states an intent; a planner run returns a plan that renders as Operation cards. The old
// per-op "run this SQL/curl" execution is removed: nothing here can write to Dub. Writes
// go through the daemon's API executor and its approval screen instead.
import { useCallback } from "react";
import type { ChatMessage } from "./lib/commanderApi.ts";
import { useChat } from "./lib/chatStore.tsx";
import { ChatComposer, MessageLog, SessionSidebar } from "./ChatUI.tsx";
import { DUB_OPERATE_CWD, OPERATE_RUN_ARGS, parsePlan, PLAN_SYSTEM_PROMPT, type Operation } from "./lib/operateDub.ts";
import { card, t } from "./lib/theme.ts";

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
            <OpCard key={op.id} op={op} />
          ))}
        </div>
      );
    },
    [],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
      <div style={{ ...card, background: t.sunken, borderColor: t.borderStrong }}>
        <p style={{ margin: 0, fontSize: 13, color: t.textMuted, lineHeight: 1.7 }}>
          Dub を自然言語で操作するための<b>計画</b>を作ります。SQL を本番に直接流す実行は廃止しました。
          実行は、許可された API だけを呼ぶ承認画面から行います。
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

function OpCard({ op }: { op: Operation }) {
  const kindLabel = op.kind === "d1_read" ? "読み取り" : op.kind === "d1_write" ? "書き込み" : "API";
  const kindColor = op.kind === "d1_read" ? t.success : op.destructive ? t.danger : t.warning;

  return (
    <div
      style={{ ...card, borderColor: op.destructive ? t.danger : t.border }}
      data-testid="operate-op"
      data-op-kind={op.kind}
      data-op-destructive={op.destructive ? "1" : "0"}
    >
      <div style={{ display: "flex", alignItems: "center", gap: t.space2 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: kindColor, borderRadius: 6, padding: `2px ${t.space2}` }}>
          {kindLabel}
        </span>
        {op.destructive && <span style={{ fontSize: 11, fontWeight: 700, color: t.danger }}>削除系（要注意）</span>}
        <span style={{ fontSize: 14, fontWeight: 600 }}>{op.title}</span>
      </div>
      {op.note && <p style={{ margin: `${t.space2} 0 0`, fontSize: 12, color: t.textMuted }}>{op.note}</p>}
    </div>
  );
}
