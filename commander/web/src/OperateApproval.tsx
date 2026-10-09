// Approval screen for one "Dubを操作" plan. Order follows what the operator must decide:
// 何を・何件・誰に first, then the targets (expandable / narrowable), the effect, whether it
// can be undone and how risky it is, then the buttons. API details stay folded under 詳細,
// and the card always ends with a one-line 結論 so the outcome is never ambiguous.
import { useState } from "react";
import { Badge, Button, Checkbox, Skeleton, SkeletonList, TextField } from "@dub/ui";
import type { ExecutionResult, Preview, PreviewCall, PreviewWrite } from "./lib/operateApi.ts";
import { API_PATH_PREFIX, CONFIRM_PHRASE, RISK_LABEL, RISK_TONE, VERDICT_TONE } from "./lib/operateLabels.ts";
import { writeCount } from "./lib/operateResult.ts";
import { t } from "./lib/theme.ts";

export type ApprovalState =
  | { status: "loading" }
  | { status: "error"; message: string; blockers: string[] }
  | { status: "ready"; preview: Preview }
  | { status: "executing"; preview: Preview; skip: string[] }
  | { status: "done"; preview: Preview; result: ExecutionResult }
  | { status: "cancelled"; preview: Preview }
  | { status: "readonly" }
  | { status: "stale"; executedLater: boolean };

const PREVIEW_TARGETS = 3;

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "（なし）";
  if (typeof v === "boolean") return v ? "オン" : "オフ";
  if (typeof v === "string") return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  if (typeof v === "number") return String(v);
  return "（複合値）";
}

function Conclusion({ text, tone }: { text: string; tone: "neutral" | "success" | "warning" | "danger" }) {
  const color = tone === "success" ? t.success : tone === "warning" ? t.warning : tone === "danger" ? t.danger : t.text;
  return (
    <p data-testid="operate-conclusion" style={{ margin: 0, paddingTop: t.space3, borderTop: `1px solid ${t.border}`, fontSize: 14, fontWeight: 700, color }}>
      結論: {text}
    </p>
  );
}

function Changes({ call, labels }: { call: PreviewCall; labels?: Record<string, string> }) {
  const fields = Object.entries(call.body ?? {}).filter(([k]) => k !== "version");
  if (!fields.length) return null;
  return (
    <ul style={{ margin: `${t.space1} 0 0`, paddingLeft: t.space5, fontSize: 13, lineHeight: 1.7 }}>
      {fields.map(([k, after]) => (
        <li key={k} data-testid="operate-change">
          {labels?.[k] ?? k}: {call.before && k in call.before ? <><s style={{ color: t.textMuted }}>{show(call.before[k])}</s> → </> : null}
          <b>{show(after)}</b>
        </li>
      ))}
    </ul>
  );
}

function WriteSection({
  write,
  narrowing,
  skip,
  onToggle,
}: {
  write: PreviewWrite;
  narrowing: boolean;
  skip: Set<string>;
  onToggle: (callId: string, keep: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const calls = write.calls;
  const visible = expanded || narrowing ? calls : calls.slice(0, PREVIEW_TARGETS);
  return (
    <section data-testid="operate-write" style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>
        {write.description}（{calls.length - calls.filter((c) => skip.has(c.callId)).length}件）
      </div>
      <ul style={{ margin: 0, paddingLeft: narrowing ? 0 : t.space5, listStyle: narrowing ? "none" : undefined, fontSize: 13 }} data-testid="operate-targets">
        {visible.map((c) => (
          <li key={c.callId} style={{ marginBottom: t.space2 }} data-testid="operate-target">
            {narrowing ? (
              <Checkbox id={`keep-${c.callId}`} checked={!skip.has(c.callId)} onChange={(keep) => onToggle(c.callId, keep)} label={c.target} testId="operate-target-check" />
            ) : (
              c.target
            )}
            <Changes call={c} labels={write.fieldLabels} />
          </li>
        ))}
      </ul>
      {!narrowing && calls.length > PREVIEW_TARGETS && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} testId="operate-expand">
            {expanded ? "たたむ" : `ほか${calls.length - PREVIEW_TARGETS}件をすべて表示`}
          </Button>
        </div>
      )}
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: `${t.space1} ${t.space3}`, margin: 0, fontSize: 13 }}>
        <dt style={{ color: t.textMuted }}>影響</dt>
        <dd style={{ margin: 0 }} data-testid="operate-impact">{write.impact}</dd>
        <dt style={{ color: t.textMuted }}>取り消し</dt>
        <dd style={{ margin: 0 }} data-testid="operate-reversible">{write.reversible ? "できる" : "できない"}</dd>
        <dt style={{ color: t.textMuted }}>リスク</dt>
        <dd style={{ margin: 0 }}>
          <Badge tone={RISK_TONE[write.risk]} testId="operate-risk">{RISK_LABEL[write.risk]}</Badge>
        </dd>
      </dl>
    </section>
  );
}

function ApiDetails({ preview }: { preview: Preview }) {
  return (
    <details data-testid="operate-details" style={{ fontSize: 12, color: t.textMuted }}>
      <summary style={{ cursor: "pointer" }}>詳細（呼び出す API）</summary>
      <ul style={{ margin: `${t.space2} 0 0`, paddingLeft: t.space5, fontFamily: "ui-monospace, monospace", lineHeight: 1.7 }}>
        {preview.writes.flatMap((w) =>
          w.calls.map((c) => (
            <li key={c.callId}>
              {c.method} {API_PATH_PREFIX}
              {c.path}
              {Object.entries(c.body ?? {}).map(([k, v]) => (
                <div key={k} style={{ paddingLeft: t.space4 }}>
                  {k}: {show(v)}
                </div>
              ))}
            </li>
          )),
        )}
      </ul>
    </details>
  );
}

export function ApprovalCard({
  state,
  onExecute,
  onCancel,
  onRetry,
}: {
  state: ApprovalState;
  onExecute: (skip: string[]) => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const [narrowing, setNarrowing] = useState(false);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [phrase, setPhrase] = useState("");

  if (state.status === "loading") {
    return (
      <div data-testid="operate-approval-loading" style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
        <Skeleton variant="text" width="60%" />
        <SkeletonList rows={3} />
      </div>
    );
  }

  if (state.status === "readonly") {
    return <Conclusion text="読み取りだけを行いました。データは変更していません" tone="neutral" />;
  }

  if (state.status === "stale") {
    return state.executedLater ? (
      <Conclusion text="この計画は実行済みです。結果は下のメッセージにあります" tone="neutral" />
    ) : (
      <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
        <Button variant="secondary" size="sm" onClick={onRetry} testId="operate-retry">
          もう一度確認する
        </Button>
        <Conclusion text="確認画面の期限が切れています。何も変更していません" tone="neutral" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div data-testid="operate-approval-error" style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
        <p style={{ margin: 0, color: t.danger, fontSize: 14 }}>{state.message}</p>
        {state.blockers.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: t.space5, fontSize: 13 }}>
            {state.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        <Conclusion text="実行できません。何も変更していません" tone="danger" />
      </div>
    );
  }

  const preview = state.preview;
  const total = writeCount(preview);
  const kept = total - skip.size;
  const high = preview.writes.some((w) => w.risk === "high");
  const blocked = preview.blockers.length > 0;
  const canRun = state.status === "ready" && !blocked && kept > 0 && (!high || phrase.trim() === CONFIRM_PHRASE);
  const what = preview.writes.map((w) => w.description).join("／") || "読み取りのみ";
  const who = preview.writes.flatMap((w) => w.calls.filter((c) => !skip.has(c.callId)).map((c) => c.target));

  return (
    <div data-testid="operate-approval" style={{ display: "flex", flexDirection: "column", gap: t.space4, width: "100%" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: t.space2 }}>
        <Badge tone={preview.environment === "本番" ? "danger" : "info"} testId="operate-env">接続先: {preview.environment}</Badge>
        {preview.writes.map((w) => (
          <Badge key={w.stepId} tone={RISK_TONE[w.risk]}>リスク{RISK_LABEL[w.risk]}</Badge>
        ))}
      </div>

      <dl data-testid="operate-headline" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: `${t.space1} ${t.space3}`, margin: 0, fontSize: 14 }}>
        <dt style={{ color: t.textMuted }}>何を</dt>
        <dd style={{ margin: 0, fontWeight: 600 }}>{what}</dd>
        <dt style={{ color: t.textMuted }}>何件</dt>
        <dd style={{ margin: 0, fontWeight: 600 }} data-testid="operate-count">{kept}件</dd>
        <dt style={{ color: t.textMuted }}>誰に</dt>
        <dd style={{ margin: 0 }}>{who.length > PREVIEW_TARGETS ? `${who.slice(0, PREVIEW_TARGETS).join("、")} ほか${who.length - PREVIEW_TARGETS}件` : who.join("、") || "（なし）"}</dd>
      </dl>

      {preview.writes.map((w) => (
        <WriteSection
          key={w.stepId}
          write={w}
          narrowing={narrowing && state.status === "ready"}
          skip={skip}
          onToggle={(id, keep) =>
            setSkip((prev) => {
              const next = new Set(prev);
              if (keep) next.delete(id);
              else next.add(id);
              return next;
            })
          }
        />
      ))}

      {blocked && (
        <ul data-testid="operate-blockers" style={{ margin: 0, paddingLeft: t.space5, fontSize: 13, color: t.danger }}>
          {preview.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}

      {state.status === "ready" && !blocked && (
        <>
          {high && (
            <label style={{ display: "flex", flexDirection: "column", gap: t.space1, fontSize: 13, color: t.danger }}>
              リスクが高い操作です。確認のため「{CONFIRM_PHRASE}」と入力してください。
              <TextField id="operate-confirm" value={phrase} onChange={setPhrase} placeholder={CONFIRM_PHRASE} testId="operate-confirm-input" />
            </label>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: t.space3 }}>
            <Button variant={high ? "danger" : "primary"} disabled={!canRun} onClick={() => onExecute([...skip])} testId="operate-execute">
              実行（{kept}件）
            </Button>
            {total > 1 && (
              <Button variant="secondary" onClick={() => setNarrowing((v) => !v)} testId="operate-narrow">
                {narrowing ? "絞り込みを終える" : "対象を減らす"}
              </Button>
            )}
            <Button variant="ghost" onClick={onCancel} testId="operate-cancel">
              やめる
            </Button>
          </div>
        </>
      )}

      {state.status === "executing" && <Button loading disabled testId="operate-executing">実行中…</Button>}

      {state.status === "done" && (
        <ul data-testid="operate-results" style={{ margin: 0, paddingLeft: t.space5, fontSize: 13, lineHeight: 1.7 }}>
          {state.result.results.map((r) => (
            <li key={r.callId} data-outcome={r.outcome}>
              {r.target}: {r.message}
            </li>
          ))}
        </ul>
      )}

      {preview.writes.length > 0 && <ApiDetails preview={preview} />}

      {state.status === "done" ? (
        <Conclusion text={state.result.headline} tone={VERDICT_TONE[state.result.verdict]} />
      ) : state.status === "cancelled" ? (
        <Conclusion text="実行をやめました。何も変更していません" tone="neutral" />
      ) : blocked ? (
        <Conclusion text="この計画は実行できません。何も変更していません" tone="danger" />
      ) : state.status === "executing" ? (
        <Conclusion text="実行中です。終わったら読み直して結果をお知らせします" tone="neutral" />
      ) : (
        <Conclusion text={`まだ何も変更していません。内容を確認して［実行］を押すと ${kept}件 を反映します`} tone="warning" />
      )}
    </div>
  );
}
