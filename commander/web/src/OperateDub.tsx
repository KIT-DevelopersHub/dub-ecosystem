// "Dubを操作する" — an operate console over the REAL Dub backend. Plan → review →
// (gated) execute. See lib/operateDub.ts for the flow. The safety gate lives HERE:
// read ops run freely; writes require an explicit confirm; destructive ops require a
// typed confirmation before the daemon ever spawns the executing command.
import { useCallback, useRef, useState } from "react";
import { HttpCommanderClient, type CommanderClient } from "./lib/client.ts";
import { parseClaudeEvent } from "./lib/askDub.ts";
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
  type OperationPlan,
} from "./lib/operateDub.ts";
import { btnPrimary, btnGhost, btnDanger, card, input, t } from "./lib/theme.ts";
import { isSubmitEnter } from "./lib/keyboard.ts";

const defaultClient = new HttpCommanderClient();

const CONFIRM_PHRASE = "実行";

const SAMPLE_INTENTS = [
  "users テーブルの現在の件数を教えて（読み取りだけ）",
  "AさんからEさんまで5人のサンプルユーザーを本番に入れて",
];

interface OperateDubProps {
  client?: CommanderClient;
}

/** Drive one claude run to completion, folding stream deltas via a callback. Resolves
 *  with the final answer text (result). Rejects only if the run can't start. */
function runToText(
  client: CommanderClient,
  prompt: string,
  onTools: (label: string) => void,
): Promise<{ text: string; failed: boolean }> {
  return new Promise((resolve, reject) => {
    client
      .startRun(prompt, { cwd: DUB_OPERATE_CWD, args: OPERATE_RUN_ARGS })
      .then(({ runId }) => {
        let acc = "";
        let sawResult = false;
        let failed = false;
        client.streamEvents(
          runId,
          (ev) => {
            if (ev.type === "status" && ev.status === "failed") failed = true;
            for (const d of parseClaudeEvent(ev)) {
              if (d.kind === "result") {
                sawResult = true;
                acc = d.text;
              } else if (d.kind === "text" && !sawResult) {
                acc += d.text;
              } else if (d.kind === "tool") {
                onTools(d.label);
              }
            }
          },
          () => resolve({ text: acc, failed }),
        );
      })
      .catch(reject);
  });
}

export function OperateDub({ client = defaultClient }: OperateDubProps) {
  const [intent, setIntent] = useState("");
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planTools, setPlanTools] = useState<string[]>([]);

  const makePlan = useCallback(
    async (text: string) => {
      const intentText = text.trim();
      if (!intentText || planning) return;
      setPlanning(true);
      setPlan(null);
      setPlanError(null);
      setPlanTools([]);
      const prompt = `${PLAN_SYSTEM_PROMPT}\n\n要望: ${intentText}`;
      try {
        const { text: answer } = await runToText(client, prompt, (label) =>
          setPlanTools((prev) => [...prev, label]),
        );
        const parsed = parsePlan(answer);
        if (parsed.ok) setPlan(parsed.plan);
        else setPlanError(`${parsed.error}\n\n${parsed.raw}`);
      } catch (err) {
        setPlanError(
          `プラン生成の起動に失敗: ${(err as Error).message}（daemon 4319 が起動しているか確認してください）`,
        );
      } finally {
        setPlanning(false);
      }
    },
    [client, planning],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
      <div style={{ ...card, background: t.sunken, borderColor: t.borderStrong }}>
        <p style={{ margin: 0, fontSize: 13, color: t.textMuted, lineHeight: 1.7 }}>
          Dub の <b>本番バックエンド</b>を自然言語で操作します（D1 / API を additive に）。
          まず<b>計画</b>を作り、<b>各操作を確認してから実行</b>します。読み取りはそのまま実行、
          <b style={{ color: t.warning }}>書き込みは要確認</b>、
          <b style={{ color: t.danger }}>削除系は「{CONFIRM_PHRASE}」の入力</b>が必要です。
          <br />
          対象 D1: <code style={{ fontSize: 12 }}>{D1_DB_NAME}</code> ・ cwd:{" "}
          <code style={{ fontSize: 12 }}>{DUB_OPERATE_CWD}</code>
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void makePlan(intent);
        }}
        style={{ display: "flex", gap: t.space3, alignItems: "flex-end" }}
      >
        <textarea
          data-testid="operate-input"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if (isSubmitEnter(e)) {
              e.preventDefault();
              void makePlan(intent);
            }
          }}
          placeholder="やりたいことを書く（例: サンプルユーザーを5人本番に入れて）"
          rows={2}
          style={{ ...input, resize: "vertical", fontFamily: "inherit" }}
          disabled={planning}
        />
        <button
          type="submit"
          style={{ ...btnPrimary, whiteSpace: "nowrap", opacity: planning || !intent.trim() ? 0.5 : 1 }}
          disabled={planning || !intent.trim()}
          data-testid="operate-plan-btn"
        >
          {planning ? "計画中…" : "計画を作成"}
        </button>
      </form>

      {plan === null && !planError && !planning && (
        <div style={{ ...card, background: t.sunken }}>
          <p style={{ marginTop: 0, color: t.textMuted, fontSize: 13 }}>例:</p>
          <div style={{ display: "flex", flexDirection: "column", gap: t.space2, alignItems: "flex-start" }}>
            {SAMPLE_INTENTS.map((s) => (
              <button
                key={s}
                type="button"
                style={{ ...btnGhost, fontWeight: 400, textAlign: "left" }}
                data-testid="operate-sample"
                onClick={() => {
                  setIntent(s);
                  void makePlan(s);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {planning && (
        <div style={{ ...card, color: t.textMuted, fontSize: 13 }} data-testid="operate-planning">
          計画中… {planTools.length > 0 && `(${planTools.length}件調査)`}
        </div>
      )}

      {planError && (
        <div
          style={{ ...card, borderColor: t.danger, color: t.text, whiteSpace: "pre-wrap", fontSize: 13 }}
          data-testid="operate-plan-error"
        >
          <b style={{ color: t.danger }}>計画を解釈できませんでした。</b>
          {"\n"}
          {planError}
        </div>
      )}

      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }} data-testid="operate-plan">
          {plan.summary && (
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7 }}>{plan.summary}</p>
          )}
          {plan.ops.length === 0 ? (
            <div style={{ ...card, color: t.textMuted }}>実行可能な操作はありませんでした。</div>
          ) : (
            plan.ops.map((op) => <OpCard key={op.id} op={op} client={client} />)
          )}
        </div>
      )}
    </div>
  );
}

type OpPhase = "idle" | "confirming" | "running" | "done" | "error";

function OpCard({ op, client }: { op: Operation; client: CommanderClient }) {
  const [phase, setPhase] = useState<OpPhase>("idle");
  const [confirmText, setConfirmText] = useState("");
  const [output, setOutput] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);

  const write = isWrite(op);
  const command = commandFor(op);

  const execute = useCallback(async () => {
    setPhase("running");
    setOutput("");
    setTools([]);
    try {
      const { text, failed } = await runToText(client, buildExecPrompt(command), (label) =>
        setTools((prev) => [...prev, label]),
      );
      setOutput(text || (failed ? "（失敗しました）" : "（出力なし）"));
      setPhase(failed ? "error" : "done");
    } catch (err) {
      setOutput(`実行の起動に失敗: ${(err as Error).message}`);
      setPhase("error");
    }
  }, [client, command]);

  const kindLabel =
    op.kind === "d1_read" ? "読み取り" : op.kind === "d1_write" ? "書き込み" : "API";
  const kindColor = op.kind === "d1_read" ? t.success : op.destructive ? t.danger : t.warning;

  return (
    <div
      style={{ ...card, borderColor: op.destructive ? t.danger : t.border }}
      data-testid="operate-op"
      data-op-kind={op.kind}
      data-op-destructive={op.destructive ? "1" : "0"}
    >
      <div style={{ display: "flex", alignItems: "center", gap: t.space2, marginBottom: t.space2 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "#fff",
            background: kindColor,
            borderRadius: 6,
            padding: `2px ${t.space2}`,
          }}
        >
          {kindLabel}
        </span>
        {op.destructive && (
          <span style={{ fontSize: 11, fontWeight: 700, color: t.danger }}>削除系（要注意）</span>
        )}
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

      {/* --- action / gate --- */}
      {phase === "idle" && !write && (
        <button type="button" style={btnGhost} data-testid="operate-op-run" onClick={() => void execute()}>
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
              style={{
                ...btnDanger,
                opacity: op.destructive && confirmText.trim() !== CONFIRM_PHRASE ? 0.5 : 1,
              }}
              data-testid="operate-op-confirm"
              disabled={op.destructive && confirmText.trim() !== CONFIRM_PHRASE}
              onClick={() => void execute()}
            >
              実行する
            </button>
          </div>
        </div>
      )}

      {phase === "running" && (
        <div style={{ fontSize: 13, color: t.textMuted }} data-testid="operate-op-running">
          実行中… {tools.length > 0 && `(${tools.length})`}
        </div>
      )}

      {(phase === "done" || phase === "error") && (
        <pre
          data-testid="operate-op-output"
          style={{
            margin: 0,
            padding: t.space3,
            background: t.sunken,
            border: `1px solid ${phase === "error" ? t.danger : t.border}`,
            borderRadius: "var(--dub-radius-sm, 8px)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: 1.6,
            maxHeight: "40vh",
            overflowY: "auto",
          }}
        >
          {output}
        </pre>
      )}
    </div>
  );
}
