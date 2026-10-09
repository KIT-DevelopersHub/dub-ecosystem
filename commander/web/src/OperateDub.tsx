// "Dubを操作する" — an operate console over the REAL Dub backend. Multi-session +
// persisted history via the shared ChatProvider. Flow per request:
//   1) a tool-less planner run gets the whole session and answers in prose or with a plan
//      over the API catalog;
//   2) a plan is previewed by the daemon at once (reads run, writes resolved, nothing
//      written) and rendered as the approval screen; a read-only plan is answered in prose
//      from the read results instead;
//   3) ［実行］ executes the approved preview once; the daemon reads every target back and
//      the verdict lands in the session as 【実行結果】 for the planner's next turn.
import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@dub/ui";
import type { ChatMessage } from "./lib/commanderApi.ts";
import { useChat } from "./lib/chatStore.tsx";
import { ChatComposer, MessageLog, SessionSidebar } from "./ChatUI.tsx";
import {
  buildAnswerPrompt,
  buildPlannerPrompt,
  OPERATE_PLANNER_ARGS,
  OPERATE_PLANNER_CWD,
  parsePlannerReply,
  RESULT_PREFIX,
  type PlannerPlan,
} from "./lib/operateDub.ts";
import { HttpOperateClient, OperateError, type CatalogEntry, type OperateClient } from "./lib/operateApi.ts";
import { CANCEL_NOTE, formatExecutionNote, formatPreviewNote, splitNote } from "./lib/operateResult.ts";
import { ApprovalCard, type ApprovalState } from "./OperateApproval.tsx";
import { card, t } from "./lib/theme.ts";

const defaultOperateClient: OperateClient = new HttpOperateClient();
const PLANNER_OPTS = { cwd: OPERATE_PLANNER_CWD, args: OPERATE_PLANNER_ARGS };

const errorState = (e: unknown): ApprovalState =>
  e instanceof OperateError
    ? { status: "error", message: e.message, blockers: e.blockers }
    : { status: "error", message: "予期しないエラーが発生しました", blockers: [] };

/** Did this plan's session get an 【実行結果】 before the next plan? (after a reload) */
function executedLater(messages: ChatMessage[], planId: string): boolean {
  const i = messages.findIndex((m) => m.id === planId);
  for (const m of messages.slice(i + 1)) {
    if (m.text.startsWith(RESULT_PREFIX.execution)) return true;
    if (m.role === "assistant" && parsePlannerReply(m.text).kind === "plan") return false;
  }
  return false;
}

export function OperateDub({ operateClient = defaultOperateClient }: { operateClient?: OperateClient }) {
  const chat = useChat();
  const sessionId = chat.activeId("operate");
  const messages = sessionId ? chat.messages(sessionId) : [];
  const busy = sessionId ? chat.isRunning(sessionId) : false;
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Record<string, ApprovalState>>({});
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let alive = true;
    operateClient
      .catalog()
      .then((c) => {
        if (!alive) return;
        setCatalog(c.entries);
        if (!c.configured) setCatalogError("Dub API の接続先が未設定のため、計画の確認と実行はできません（daemon の設定が必要です）");
      })
      .catch((e: Error) => alive && setCatalogError(e.message));
    return () => {
      alive = false;
    };
  }, [operateClient]);

  const setApproval = useCallback((id: string, s: ApprovalState) => setApprovals((prev) => ({ ...prev, [id]: s })), []);

  const previewPlan = useCallback(
    async (sid: string, planMsgId: string, plan: PlannerPlan, history: ChatMessage[]) => {
      if (!catalog) return;
      setApproval(planMsgId, { status: "loading" });
      setPending(true);
      try {
        const preview = await operateClient.preview(plan);
        const note = await chat.note(sid, formatPreviewNote(preview));
        if (preview.writes.length === 0 && preview.blockers.length === 0) {
          setApproval(planMsgId, { status: "readonly" });
          const withNote = note ? [...history, note] : history;
          await chat.run("operate", sid, { prompt: buildAnswerPrompt({ catalog, history: withNote }), opts: PLANNER_OPTS });
        } else {
          setApproval(planMsgId, { status: "ready", preview });
        }
      } catch (e) {
        const s = errorState(e);
        setApproval(planMsgId, s);
        if (s.status === "error") await chat.note(sid, `${RESULT_PREFIX.preview}実行できません: ${[s.message, ...s.blockers].join(" / ")}`);
      } finally {
        setPending(false);
      }
    },
    [catalog, chat, operateClient, setApproval],
  );

  const planIntent = useCallback(
    async (text: string) => {
      if (!catalog) return;
      let sid = chat.activeId("operate");
      if (!sid) sid = (await chat.create("operate"))?.id ?? null;
      if (!sid) return;
      const history = chat.messages(sid);
      const msg = await chat.run("operate", sid, {
        userText: text,
        prompt: buildPlannerPrompt({ catalog, history, request: text }),
        opts: PLANNER_OPTS,
      });
      if (!msg || msg.status !== "done") return;
      const reply = parsePlannerReply(msg.text);
      // The store snapshot in this closure predates the run, so pass the turn explicitly.
      const asked: ChatMessage = { ...msg, id: `${msg.id}-q`, role: "user", text };
      if (reply.kind === "plan") await previewPlan(sid, msg.id, reply.plan, [...history, asked, msg]);
    },
    [chat, catalog, previewPlan],
  );

  const execute = useCallback(
    async (planMsgId: string, skip: string[]) => {
      const sid = chat.activeId("operate");
      const s = approvals[planMsgId];
      if (!sid || s?.status !== "ready") return;
      setApproval(planMsgId, { status: "executing", preview: s.preview, skip });
      setPending(true);
      try {
        const result = await operateClient.execute(s.preview.previewId, skip);
        setApproval(planMsgId, { status: "done", preview: s.preview, result });
        await chat.note(sid, formatExecutionNote(result));
      } catch (e) {
        const err = errorState(e);
        setApproval(planMsgId, err);
        if (err.status === "error") await chat.note(sid, `${RESULT_PREFIX.execution}できませんでした: ${err.message}`);
      } finally {
        setPending(false);
      }
    },
    [approvals, chat, operateClient, setApproval],
  );

  const cancel = useCallback(
    async (planMsgId: string) => {
      const sid = chat.activeId("operate");
      const s = approvals[planMsgId];
      if (!sid || s?.status !== "ready") return;
      setApproval(planMsgId, { status: "cancelled", preview: s.preview });
      await chat.note(sid, CANCEL_NOTE);
    },
    [approvals, chat, setApproval],
  );

  const renderBody = useCallback(
    (msg: ChatMessage) => {
      if (msg.role !== "assistant") return undefined;
      // While streaming, never show the half-written JSON: intro text + a skeleton.
      if (msg.status === "streaming") {
        const fence = msg.text.indexOf("```");
        if (fence < 0) return undefined;
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: t.space2, width: "100%" }}>
            {msg.text.slice(0, fence).trim() && <p style={{ margin: 0, fontSize: 14 }}>{msg.text.slice(0, fence).trim()}</p>}
            <Skeleton variant="text" width="70%" />
            <Skeleton variant="text" width="40%" />
          </div>
        );
      }
      // Console-written notes (for the planner's memory) stay quiet: the card already shows them.
      if (msg.text.startsWith(RESULT_PREFIX.preview) || msg.text.startsWith(RESULT_PREFIX.execution)) {
        const { visible, data } = splitNote(msg.text);
        return (
          <div data-testid="operate-note" style={{ fontSize: 13, color: t.textMuted, whiteSpace: "pre-wrap", width: "100%" }}>
            {visible}
            {data && (
              <details style={{ marginTop: t.space2 }}>
                <summary style={{ cursor: "pointer" }}>詳細（読み取ったデータ）</summary>
                <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{data}</pre>
              </details>
            )}
          </div>
        );
      }
      const reply = parsePlannerReply(msg.text);
      if (reply.kind === "answer") return undefined;
      if (reply.kind === "invalid") return <p style={{ margin: 0, fontSize: 14, color: t.danger }}>{reply.error}</p>;
      const sid = chat.activeId("operate");
      const state = approvals[msg.id] ?? { status: "stale", executedLater: executedLater(messages, msg.id) };
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space4, width: "100%" }}>
          <PlanView plan={reply.plan} intro={reply.intro} />
          <ApprovalCard
            state={state}
            onExecute={(skip) => void execute(msg.id, skip)}
            onCancel={() => void cancel(msg.id)}
            onRetry={() => sid && void previewPlan(sid, msg.id, reply.plan, messages)}
          />
        </div>
      );
    },
    [approvals, cancel, chat, execute, messages, previewPlan],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
      <div style={{ ...card, background: t.sunken, borderColor: t.borderStrong }}>
        <p style={{ margin: 0, fontSize: 13, color: t.textMuted, lineHeight: 1.7 }}>
          Dub のデータを自然言語で操作します。使えるのは<b>イベント編集・メール発行・通知</b>の許可された API だけです。
          書き込みは必ず変更内容を確認してから実行し、実行後に読み直して結果をお知らせします。
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
          {catalog === null && !catalogError ? (
            <div data-testid="operate-loading" style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
              <Skeleton variant="text" width="50%" />
              <Skeleton variant="text" width="80%" />
            </div>
          ) : (
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
          )}
          <ChatComposer
            sessionId={sessionId ?? "none"}
            placeholder="やりたいことを書く（例: 通知『デプロイ完了』を削除して）"
            disabled={busy || pending || !catalog}
            busy={busy || pending}
            sendLabel="送信"
            onSend={(text) => void planIntent(text)}
          />
        </div>
      </div>
    </div>
  );
}

function PlanView({ plan, intro }: { plan: PlannerPlan; intro: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }} data-testid="operate-plan">
      {intro && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7 }}>{intro}</p>}
      {plan.summary && <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{plan.summary}</p>}
    </div>
  );
}
