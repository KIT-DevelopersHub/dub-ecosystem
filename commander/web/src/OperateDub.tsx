// "Dubを操作する" — an operate console over the REAL Dub backend. Multi-session +
// persisted history via the shared ChatProvider. Flow per request:
//   1) a tool-less planner run gets the whole session and answers in prose or with a plan
//      over the API catalog;
//   2) a plan is previewed by the daemon at once (reads run, writes resolved, nothing
//      written) and rendered as the approval screen; a read-only plan is answered in prose
//      from the compacted read tables instead — over the read budget it is narrowed by
//      the planner or put to the operator first (lib/operateBudget.ts);
//   3) ［実行］ executes the approved preview once; the daemon reads every target back and
//      the verdict lands in the session as 【実行結果】 for the planner's next turn.
import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@dub/ui";
import type { ChatMessage } from "./lib/commanderApi.ts";
import type { ChatImage } from "./lib/images.ts";
import { useChat } from "./lib/chatStore.tsx";
import { ChatComposer, MessageLog, SessionSidebar } from "./ChatUI.tsx";
import {
  buildAnswerPrompt,
  buildNarrowPrompt,
  buildPlannerPrompt,
  OPERATE_PLANNER_ARGS,
  OPERATE_PLANNER_CWD,
  parsePlannerReply,
  RESULT_PREFIX,
  type NarrowOption,
  type PlannerPlan,
} from "./lib/operateDub.ts";
import { HttpOperateClient, OperateError, type CatalogEntry, type OperateClient, type Preview } from "./lib/operateApi.ts";
import { describeEmptyMatch, describeOverBudget, FULL_READ_BUDGET_BYTES, readBytes, READ_BUDGET_BYTES, runReadFlow } from "./lib/operateBudget.ts";
import { CANCEL_NOTE, formatExecutionNote, formatPreviewNote, kb, readData, splitNote } from "./lib/operateResult.ts";
import { ApprovalCard, type ApprovalState } from "./OperateApproval.tsx";
import { Markdown } from "./Markdown.tsx";
import { card, t } from "./lib/theme.ts";

const defaultOperateClient: OperateClient = new HttpOperateClient();
const PLANNER_OPTS = { cwd: OPERATE_PLANNER_CWD, args: OPERATE_PLANNER_ARGS };

/** First line of every answer: where the data came from (staging = seed data). */
export function environmentSeed(environment: string): string {
  if (environment === "staging") return "**接続先: staging**（テスト用の seed データです。本番のデータではありません）\n\n";
  if (environment === "ローカル") return "**接続先: ローカル**（開発用のデータです）\n\n";
  return `**接続先: ${environment}**\n\n`;
}

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
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Record<string, ApprovalState>>({});
  // Per session: a preview/execute in one chat must not lock the composer of another.
  const [pendingBySession, setPendingBySession] = useState<Record<string, number>>({});
  const setPending = useCallback(
    (sid: string, on: boolean) => setPendingBySession((prev) => ({ ...prev, [sid]: Math.max(0, (prev[sid] ?? 0) + (on ? 1 : -1)) })),
    [],
  );
  const busy = sessionId ? chat.isRunning(sessionId) || (pendingBySession[sessionId] ?? 0) > 0 : false;

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

  /** Persist the read tables and answer from them (they are given whole to the answerer). */
  const answer = useCallback(
    async (sid: string, preview: Preview, history: ChatMessage[]) => {
      if (!catalog) return;
      const note = await chat.note(sid, formatPreviewNote(preview));
      await chat.run("operate", sid, {
        prompt: buildAnswerPrompt({ catalog, history: note ? [...history, note] : history, readData: readData(preview), noteId: note?.id }),
        opts: PLANNER_OPTS,
        assistantSeed: environmentSeed(preview.environment),
      });
    },
    [catalog, chat],
  );

  const fail = useCallback(
    async (sid: string, msgId: string, e: unknown) => {
      const s = errorState(e);
      setApproval(msgId, s);
      if (s.status === "error") await chat.note(sid, `${RESULT_PREFIX.preview}実行できません: ${[s.message, ...s.blockers].join(" / ")}`);
    },
    [chat, setApproval],
  );

  /** Preview a plan; read-only ones go through the read budget (operateBudget.ts). */
  const previewPlan = useCallback(
    async (sid: string, planMsgId: string, plan: PlannerPlan, history: ChatMessage[], opts: { rounds?: number } = {}) => {
      if (!catalog) return;
      setApproval(planMsgId, { status: "loading" });
      setPending(sid, true);
      // The store snapshot in this closure is stale during the flow: track the turn here.
      let hist = history;
      try {
        const out = await runReadFlow(
          { msgId: planMsgId, plan },
          {
            catalog,
            preview: (p) => operateClient.preview(p),
            onOverBudget: async (turn, preview, kind) => {
              const why =
                kind === "empty" ? "条件に合う対象が見つからなかったため"
                : preview.readLimit ? `読み取り回数が上限（${preview.readLimit.max}回）を超えたため`
                : `読み取り結果が約 ${kb(readBytes(preview))} あり、上限（${kb(READ_BUDGET_BYTES)}）を超えたため`;
              setApproval(turn.msgId, { status: "narrowed", why });
              const note = await chat.note(sid, `${formatPreviewNote(preview, { withData: kind === "empty" })}\n- ${why}、計画を見直して読み直します`);
              if (note) hist = [...hist, note];
            },
            narrow: async ({ plan: p, preview, last, why }) => {
              const facts = why === "empty" ? describeEmptyMatch(preview, p) : describeOverBudget(preview, catalog);
              const msg = await chat.run("operate", sid, {
                prompt: buildNarrowPrompt({ catalog, history: hist, plan: p, facts, last, why }),
                opts: PLANNER_OPTS,
              });
              if (!msg || msg.status !== "done") return null;
              hist = [...hist, msg];
              const reply = parsePlannerReply(msg.text);
              if (reply.kind === "plan") setApproval(msg.id, { status: "loading" });
              return { msgId: msg.id, reply };
            },
          },
          opts,
        );
        if (out.kind === "error") {
          await fail(sid, out.msgId, out.error);
        } else if (out.kind === "confirm") {
          setApproval(out.msgId, { status: "overBudget", preview: out.preview, reason: out.reason, options: out.options });
        } else if (out.kind === "answer") {
          setApproval(out.turn.msgId, { status: "readonly" });
          await answer(sid, out.preview, hist);
        } else {
          await chat.note(sid, formatPreviewNote(out.preview, { withData: readBytes(out.preview) <= READ_BUDGET_BYTES }));
          setApproval(out.turn.msgId, { status: "ready", preview: out.preview });
        }
      } catch (e) {
        await fail(sid, planMsgId, e);
      } finally {
        setPending(sid, false);
      }
    },
    [answer, catalog, chat, fail, operateClient, setApproval, setPending],
  );

  /** 全部読む: the budget is raised once for the preview already read. */
  const readAll = useCallback(
    async (msgId: string) => {
      const sid = chat.activeId("operate");
      const s = approvals[msgId];
      if (!sid || s?.status !== "overBudget" || s.preview.readLimit || readBytes(s.preview) > FULL_READ_BUDGET_BYTES) return;
      setApproval(msgId, { status: "readonly" });
      setPending(sid, true);
      try {
        await answer(sid, s.preview, messages);
      } finally {
        setPending(sid, false);
      }
    },
    [answer, approvals, chat, messages, setApproval, setPending],
  );

  /** 絞り込む: the chosen narrowing becomes the next plan (no further automatic rounds). */
  const narrowTo = useCallback(
    async (msgId: string, option: NarrowOption) => {
      const sid = chat.activeId("operate");
      if (!sid || approvals[msgId]?.status !== "overBudget") return;
      setApproval(msgId, { status: "readonly" });
      const planNote = await chat.note(sid, `絞り込み「${option.label}」で読み直します。\n\`\`\`json\n${JSON.stringify(option.plan)}\n\`\`\``);
      if (!planNote) return;
      await previewPlan(sid, planNote.id, option.plan, [...messages, planNote], { rounds: 0 });
    },
    [approvals, chat, messages, previewPlan, setApproval],
  );

  const planIntent = useCallback(
    async (text: string, images: ChatImage[] = []) => {
      if (!catalog) return;
      let sid = chat.activeId("operate");
      if (!sid) sid = (await chat.create("operate"))?.id ?? null;
      if (!sid) return;
      const history = chat.messages(sid);
      const msg = await chat.run("operate", sid, {
        userText: text,
        prompt: buildPlannerPrompt({ catalog, history, request: text }),
        opts: PLANNER_OPTS,
        images,
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
      setPending(sid, true);
      try {
        const result = await operateClient.execute(s.preview.previewId, skip);
        setApproval(planMsgId, { status: "done", preview: s.preview, result });
        await chat.note(sid, formatExecutionNote(result));
      } catch (e) {
        const err = errorState(e);
        setApproval(planMsgId, err);
        if (err.status === "error") await chat.note(sid, `${RESULT_PREFIX.execution}できませんでした: ${err.message}`);
      } finally {
        setPending(sid, false);
      }
    },
    [approvals, chat, operateClient, setApproval, setPending],
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
      // Answers carry tables: render them as tables, not as pipes and dashes.
      if (reply.kind === "answer") {
        return (
          <div data-testid="operate-answer" style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, padding: `${t.space3} ${t.space4}`, width: "100%", boxSizing: "border-box" }}>
            <Markdown text={msg.text} />
          </div>
        );
      }
      if (reply.kind === "invalid") return <p style={{ margin: 0, fontSize: 14, color: t.danger }}>{reply.error}</p>;
      const sid = chat.activeId("operate");
      const budgetHandlers = { onReadAll: () => void readAll(msg.id), onNarrow: (o: NarrowOption) => void narrowTo(msg.id, o) };
      if (reply.kind === "needsFull") {
        const state = approvals[msg.id];
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: t.space4, width: "100%" }} data-testid="operate-needs-full">
            {reply.intro && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7 }}>{reply.intro}</p>}
            {/* The card repeats the reason next to the choices; without one, say it here. */}
            {!state && <p style={{ margin: 0, fontSize: 14 }}>全件の読み取りが必要と判断しました。{reply.reason}</p>}
            {state && <ApprovalCard state={state} onExecute={() => {}} onCancel={() => {}} onRetry={() => {}} {...budgetHandlers} />}
          </div>
        );
      }
      const state = approvals[msg.id] ?? { status: "stale", executedLater: executedLater(messages, msg.id) };
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space4, width: "100%" }}>
          <PlanView plan={reply.plan} intro={reply.intro} />
          <ApprovalCard
            state={state}
            onExecute={(skip) => void execute(msg.id, skip)}
            onCancel={() => void cancel(msg.id)}
            onRetry={() => sid && void previewPlan(sid, msg.id, reply.plan, messages)}
            {...budgetHandlers}
          />
        </div>
      );
    },
    [approvals, cancel, chat, execute, messages, narrowTo, previewPlan, readAll],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
      <div style={{ ...card, background: t.sunken, borderColor: t.borderStrong }}>
        <p style={{ margin: 0, fontSize: 13, color: t.textMuted, lineHeight: 1.7 }}>
          Dub のデータを自然言語で操作します。使えるのは<b>許可された API だけ</b>です（物理削除は含みません。取り消せない操作は確認画面に「取り消し: できない」と出ます）。
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
            disabled={busy || !catalog}
            busy={busy}
            sendLabel="送信"
            onSend={(text, images) => void planIntent(text, images)}
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
      <details data-testid="operate-plan-details" style={{ fontSize: 12, color: t.textMuted }}>
        <summary style={{ cursor: "pointer" }}>詳細（計画の手順）</summary>
        <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{JSON.stringify(plan.steps, null, 2)}</pre>
      </details>
    </div>
  );
}
