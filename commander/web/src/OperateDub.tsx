// "Dubを操作する" — an operate console over the REAL Dub backend. Multi-session +
// persisted history via the shared ChatProvider. Each request goes to a tool-less planner
// run together with the whole session, which answers in prose or returns a plan over the
// API catalog. Plans render in Japanese; they never reach Dub from here — execution is the
// daemon executor's job (/operate/*).
import { useCallback, useEffect, useState } from "react";
import type { ChatMessage } from "./lib/commanderApi.ts";
import { useChat } from "./lib/chatStore.tsx";
import { ChatComposer, MessageLog, SessionSidebar } from "./ChatUI.tsx";
import {
  buildPlannerPrompt,
  OPERATE_PLANNER_ARGS,
  OPERATE_PLANNER_CWD,
  parsePlannerReply,
  type PlannerPlan,
} from "./lib/operateDub.ts";
import { HttpOperateClient, type CatalogEntry, type OperateClient } from "./lib/operateApi.ts";
import { card, t } from "./lib/theme.ts";

const defaultOperateClient: OperateClient = new HttpOperateClient();

export function OperateDub({ operateClient = defaultOperateClient }: { operateClient?: OperateClient }) {
  const chat = useChat();
  const sessionId = chat.activeId("operate");
  const messages = sessionId ? chat.messages(sessionId) : [];
  const busy = sessionId ? chat.isRunning(sessionId) : false;
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    operateClient
      .catalog()
      .then((c) => alive && setCatalog(c.entries))
      .catch((e: Error) => alive && setCatalogError(e.message));
    return () => {
      alive = false;
    };
  }, [operateClient]);

  const planIntent = useCallback(
    async (text: string) => {
      if (!catalog) return;
      let sid = chat.activeId("operate");
      if (!sid) sid = (await chat.create("operate"))?.id ?? null;
      if (!sid) return;
      const history = chat.messages(sid);
      void chat.run("operate", sid, {
        userText: text,
        prompt: buildPlannerPrompt({ catalog, history, request: text }),
        opts: { cwd: OPERATE_PLANNER_CWD, args: OPERATE_PLANNER_ARGS },
      });
    },
    [chat, catalog],
  );

  const renderBody = useCallback(
    (msg: ChatMessage) => {
      if (msg.role !== "assistant" || msg.status === "streaming") return undefined;
      const reply = parsePlannerReply(msg.text);
      if (reply.kind === "answer") return undefined;
      if (reply.kind === "invalid") {
        return <p style={{ margin: 0, fontSize: 14, color: t.danger }}>{reply.error}</p>;
      }
      return <PlanView plan={reply.plan} intro={reply.intro} catalog={catalog ?? []} />;
    },
    [catalog],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
      <div style={{ ...card, background: t.sunken, borderColor: t.borderStrong }}>
        <p style={{ margin: 0, fontSize: 13, color: t.textMuted, lineHeight: 1.7 }}>
          Dub のデータを自然言語で操作します。使えるのは<b>イベント編集・メール発行・通知</b>の許可された API だけです。
          書き込みは必ず変更内容を確認してから実行します。
        </p>
        {catalogError && (
          <p style={{ margin: `${t.space2} 0 0`, fontSize: 13, color: t.danger }} data-testid="operate-catalog-error">
            {catalogError}
          </p>
        )}
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
                <p style={{ fontSize: 12 }}>例: 「北陸ITカンファレンス2027 の概要を差し替えて」「メールが無い人に発行して」</p>
              </>
            }
          />
          <ChatComposer
            sessionId={sessionId ?? "none"}
            placeholder="やりたいことを書く（例: 通知『デプロイ完了』を削除して）"
            disabled={busy || !catalog}
            busy={busy}
            sendLabel="送信"
            onSend={(text) => void planIntent(text)}
          />
        </div>
      </div>
    </div>
  );
}

function PlanView({ plan, intro, catalog }: { plan: PlannerPlan; intro: string; catalog: CatalogEntry[] }) {
  const byId = new Map(catalog.map((e) => [e.id, e]));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space3, width: "100%" }} data-testid="operate-plan">
      {intro && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7 }}>{intro}</p>}
      {plan.summary && <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{plan.summary}</p>}
      <ol style={{ margin: 0, paddingLeft: t.space5, fontSize: 13, lineHeight: 1.8, color: t.textMuted }}>
        {plan.steps.map((s) => {
          const entry = byId.get(s.op);
          return (
            <li key={s.id} data-testid="operate-plan-step">
              {entry ? entry.description : `許可されていない操作（${s.op}）`}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
