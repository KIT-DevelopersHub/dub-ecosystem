// Read budget for "Dubを操作": how a read-only plan's results reach the answerer.
//   (a) the daemon compacts every read to its main fields (all rows); within budget it is
//       handed to the answerer as is;
//   (b) over budget it is NOT handed on: the plan goes back to the planner with the op,
//       rows, size and the op's filters, at most MAX_NARROW_ROUNDS times, stopping early
//       when the same plan comes back. Reads only — no approval needed, and a reply that
//       contains a write op is never previewed on this path;
//   (c) when the planner says the full read is needed (needsFull), or the rounds run out,
//       the operator chooses: 全部読む (budget raised to FULL_READ_BUDGET_BYTES once) or
//       one of the planner's narrowings.
// A read-only plan stopped only by the daemon's read-call cap (readLimit) is narrowed the
// same way; 全部読む is not offered for it (the reads were never all made). A forEach whose
// where matched none of a non-empty list (usually a name the planner re-spelt) also goes
// back to the planner, but when the rounds run out it is answered as is ("0件" is real).
// Plans with writes never enter this path: they go to the approval screen as before.

import type { CatalogEntry, Preview } from "./operateApi.ts";
import type { NarrowOption, PlannerPlan, PlannerReply } from "./operateDub.ts";
import { kb } from "./operateResult.ts";

/**
 * 24 KB of compacted tables = about 150-250 task rows (one event's whole task list fits
 * several times over) and well under a tenth of the answerer's context, next to the
 * catalog and the 60k-char transcript.
 */
export const READ_BUDGET_BYTES = 24 * 1024;
/** 全部読む: raised once, still leaving the context room for the catalog and transcript. */
export const FULL_READ_BUDGET_BYTES = 96 * 1024;
export const MAX_NARROW_ROUNDS = 2;

export const readBytes = (preview: Preview): number => preview.reads.reduce((n, r) => n + (r.bytes ?? 0), 0);

/** The only blocker is the read-call cap: too big a read, not a broken plan. */
export const onlyReadLimit = (preview: Preview): boolean => !!preview.readLimit && preview.blockers.length === 1;

/** Every step names a read entry of the catalog (unknown ops count as not read-only). */
export function isReadOnlyPlan(plan: PlannerPlan, catalog: CatalogEntry[]): boolean {
  return plan.steps.every((s) => catalog.find((e) => e.id === s.op)?.kind === "read");
}

const planKey = (plan: PlannerPlan): string => JSON.stringify(plan.steps);

/** forEach reads whose where matched nothing out of a non-empty list. */
export const emptyMatches = (preview: Preview) => preview.reads.filter((r) => r.filtered && r.filtered.from > 0 && r.filtered.matched === 0);

/** What the planner is told when a read is sent back: op, rows, size, usable filters. */
export function describeOverBudget(preview: Preview, catalog: CatalogEntry[], budget = READ_BUDGET_BYTES): string {
  return [
    preview.readLimit
      ? `読み取り回数が上限を超えました（${preview.readLimit.calls}回目で停止・上限 ${preview.readLimit.max}回）。forEach の対象を where や条件で減らしてください`
      : `読み取り結果の合計: 約 ${kb(readBytes(preview))}（上限 ${kb(budget)}）`,
    ...preview.reads
      .filter((r) => r.ok)
      .map((r) => {
        const filters = catalog.find((e) => e.id === r.entryId)?.query ?? [];
        return `- 手順 ${r.stepId}（${r.entryId}・${r.description}）: ${r.rows ?? r.count ?? 0}行・約 ${kb(r.bytes ?? 0)}・使える絞り込み: ${filters.length ? filters.join(", ") : "なし"}`;
      }),
  ].join("\n");
}

/** A where that matched nothing: name the step and its conditions so the planner can fix it. */
export function describeEmptyMatch(preview: Preview, plan: PlannerPlan): string {
  return [
    "次の手順は、繰り返し対象の一覧に where に合うものが1件もありませんでした（名前の表記違いのことが多い）。",
    ...emptyMatches(preview).map((r) => {
      const where = plan.steps.find((s) => s.id === r.stepId)?.where;
      return `- 手順 ${r.stepId}（${r.entryId}）: ${r.filtered!.from}件中 0件・条件 ${JSON.stringify(where ?? [])}`;
    }),
    "前の確認結果の表にある実際の表記（イベント名・チーム名など）に合わせて直した計画を返してください。依頼文の名前を訳したり言い換えたりしないこと。本当に該当が無いなら、直前と同じ計画を返してください。",
  ].join("\n");
}

export interface PlanTurn {
  /** Chat message holding the plan (the approval / confirm card attaches to it). */
  msgId: string;
  plan: PlannerPlan;
}

export type ReadFlowResult =
  | { kind: "approval"; turn: PlanTurn; preview: Preview }
  | { kind: "answer"; turn: PlanTurn; preview: Preview }
  | { kind: "confirm"; msgId: string; preview: Preview; reason: string; options: NarrowOption[] }
  | { kind: "error"; msgId: string; error: unknown };

/** Why a read goes back to the planner. */
export type RetryWhy = "over" | "empty";

export interface ReadFlowDeps {
  catalog: CatalogEntry[];
  preview(plan: PlannerPlan): Promise<Preview>;
  /** A read sent back (persist the facts, mark the plan as re-planned). */
  onOverBudget(turn: PlanTurn, preview: Preview, why: RetryWhy): Promise<void>;
  /** Send the read back to the planner; null = the run failed. */
  narrow(input: { plan: PlannerPlan; preview: Preview; last: boolean; why: RetryWhy }): Promise<{ msgId: string; reply: PlannerReply } | null>;
}

export async function runReadFlow(first: PlanTurn, deps: ReadFlowDeps, opts: { rounds?: number } = {}): Promise<ReadFlowResult> {
  const maxRounds = opts.rounds ?? MAX_NARROW_ROUNDS;
  const seen = new Set([planKey(first.plan)]);
  let turn = first;
  for (let round = 0; ; round++) {
    let preview: Preview;
    try {
      preview = await deps.preview(turn.plan);
    } catch (error) {
      return { kind: "error", msgId: turn.msgId, error };
    }
    const readOnly = isReadOnlyPlan(turn.plan, deps.catalog) && preview.writes.length === 0;
    const capped = onlyReadLimit(preview);
    if (!readOnly || (preview.blockers.length > 0 && !capped)) return { kind: "approval", turn, preview };
    const over = capped || readBytes(preview) > READ_BUDGET_BYTES;
    const why: RetryWhy | null = over ? "over" : emptyMatches(preview).length > 0 ? "empty" : null;
    const answer: ReadFlowResult = { kind: "answer", turn, preview };
    if (!why) return answer;

    // An empty match that cannot be fixed is still a true answer ("0件"); only an
    // over-budget read has to be put to the operator.
    const confirm = (msgId: string, reason: string, options: NarrowOption[] = []): ReadFlowResult =>
      why === "empty"
        ? answer
        : { kind: "confirm", msgId, preview, reason, options: options.filter((o) => isReadOnlyPlan(o.plan, deps.catalog)) };
    if (round >= maxRounds) {
      return confirm(turn.msgId, maxRounds ? `${maxRounds}回絞り込んでも上限に収まりませんでした` : "上限に収まりませんでした");
    }
    await deps.onOverBudget(turn, preview, why);
    const res = await deps.narrow({ plan: turn.plan, preview, last: round + 1 >= maxRounds, why });
    if (!res) return confirm(turn.msgId, "絞り込みの計画を受け取れませんでした");
    const { reply } = res;
    if (reply.kind === "needsFull") return confirm(res.msgId, reply.reason || "全件の読み取りが必要です", reply.options);
    if (reply.kind !== "plan") return confirm(res.msgId, "絞り込みの計画を受け取れませんでした");
    if (!isReadOnlyPlan(reply.plan, deps.catalog)) return confirm(res.msgId, "絞り込みの計画に読み取り以外の操作が含まれていたため使いません");
    if (seen.has(planKey(reply.plan))) return confirm(res.msgId, "同じ計画が返ってきたため、これ以上は絞り込みません");
    seen.add(planKey(reply.plan));
    turn = { msgId: res.msgId, plan: reply.plan };
  }
}
