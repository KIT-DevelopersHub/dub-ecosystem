import { describe, it, expect, vi } from "vitest";
import type { Preview } from "./operateApi.ts";
import type { PlannerPlan, PlannerReply } from "./operateDub.ts";
import { describeEmptyMatch, describeOverBudget, MAX_NARROW_ROUNDS, READ_BUDGET_BYTES, runReadFlow, type ReadFlowDeps } from "./operateBudget.ts";
import { FAKE_CATALOG } from "../test/operateFakes.ts";

const CATALOG = [
  ...FAKE_CATALOG,
  { id: "tasks.list", area: "task" as const, method: "GET", path: "/tasks", kind: "read" as const, reversible: true, risk: "low" as const, description: "タスクの一覧を取得する", impact: "", query: ["eventId", "teamId", "assigneeId", "status"] },
];

const plan = (tag: string, op = "tasks.list"): PlannerPlan => ({ type: "plan", summary: tag, steps: [{ id: "t", op, query: { tag } }] });
const preview = (bytes: number, writes: Preview["writes"] = []): Preview => ({
  previewId: "pv",
  summary: "",
  environment: "staging",
  reads: [{ stepId: "t", entryId: "tasks.list", description: "タスクの一覧を取得する", ok: true, count: 1, rows: 400, bytes, table: "items（400件）" }],
  writes,
  blockers: [],
  expiresAt: "",
});
const BIG = READ_BUDGET_BYTES + 1;

function deps(sizes: number[], replies: PlannerReply[]) {
  let p = 0;
  let r = 0;
  return {
    catalog: CATALOG,
    preview: vi.fn(async (_plan: PlannerPlan) => preview(sizes[Math.min(p++, sizes.length - 1)]!)),
    onOverBudget: vi.fn(async () => {}),
    narrow: vi.fn(async (_input: { last: boolean; why: string }) => ({ msgId: `n${r + 1}`, reply: replies[Math.min(r++, replies.length - 1)]! })),
  } satisfies ReadFlowDeps;
}

describe("runReadFlow", () => {
  it("hands a read within budget straight to the answerer", async () => {
    const d = deps([READ_BUDGET_BYTES], []);
    const out = await runReadFlow({ msgId: "m1", plan: plan("a") }, d);
    expect(out.kind).toBe("answer");
    expect(d.narrow).not.toHaveBeenCalled();
  });

  it("sends an over-budget read back to the planner and answers from the narrowed plan", async () => {
    const d = deps([BIG, 1000], [{ kind: "plan", plan: plan("narrow"), intro: "" }]);
    const out = await runReadFlow({ msgId: "m1", plan: plan("a") }, d);
    expect(out).toMatchObject({ kind: "answer", turn: { msgId: "n1", plan: { summary: "narrow" } } });
    expect(d.onOverBudget).toHaveBeenCalledTimes(1);
    expect(d.preview).toHaveBeenLastCalledWith(plan("narrow"));
  });

  it(`stops after ${MAX_NARROW_ROUNDS} rounds and asks the operator`, async () => {
    const d = deps([BIG], [1, 2, 3, 4].map((i) => ({ kind: "plan" as const, plan: plan(`n${i}`), intro: "" })));
    const out = await runReadFlow({ msgId: "m1", plan: plan("a") }, d);
    expect(d.narrow).toHaveBeenCalledTimes(MAX_NARROW_ROUNDS);
    expect(d.preview).toHaveBeenCalledTimes(MAX_NARROW_ROUNDS + 1);
    expect(d.narrow.mock.calls.map((c) => c[0].last)).toEqual([false, true]);
    expect(out).toMatchObject({ kind: "confirm", msgId: "n2", reason: expect.stringMatching(/2回絞り込んでも/) });
  });

  it("stops early when the planner returns the same plan", async () => {
    const d = deps([BIG], [{ kind: "plan", plan: plan("a"), intro: "" }]);
    const out = await runReadFlow({ msgId: "m1", plan: plan("a") }, d);
    expect(d.narrow).toHaveBeenCalledTimes(1);
    expect(d.preview).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ kind: "confirm", reason: expect.stringMatching(/同じ計画/) });
  });

  it("needsFull puts the choice to the operator without answering, dropping write options", async () => {
    const d = deps([BIG], [
      {
        kind: "needsFull",
        reason: "全員分が要ります",
        intro: "",
        options: [
          { label: "法人チームだけ", plan: plan("corp") },
          { label: "ついでに更新", plan: plan("w", "events.update") },
        ],
      },
    ]);
    const out = await runReadFlow({ msgId: "m1", plan: plan("a") }, d);
    expect(out.kind).toBe("confirm");
    if (out.kind !== "confirm") return;
    expect(out.msgId).toBe("n1");
    expect(out.reason).toBe("全員分が要ります");
    expect(out.options.map((o) => o.label)).toEqual(["法人チームだけ"]);
    expect(d.preview).toHaveBeenCalledTimes(1);
  });

  it("never previews a narrowed plan that contains a write op", async () => {
    const d = deps([BIG], [{ kind: "plan", plan: plan("w", "events.update"), intro: "" }]);
    const out = await runReadFlow({ msgId: "m1", plan: plan("a") }, d);
    expect(out).toMatchObject({ kind: "confirm", reason: expect.stringMatching(/読み取り以外/) });
    expect(d.preview).toHaveBeenCalledTimes(1);
  });

  it("a plan with writes goes to the approval screen however big its reads are", async () => {
    const write = { stepId: "u", entryId: "events.update", kind: "write" as const, risk: "mid" as const, reversible: true, description: "", impact: "", calls: [] };
    const d = { ...deps([BIG], []), preview: vi.fn(async () => preview(BIG, [write])) };
    const out = await runReadFlow({ msgId: "m1", plan: { type: "plan", summary: "", steps: [{ id: "t", op: "tasks.list" }, { id: "u", op: "events.update" }] } }, d);
    expect(out.kind).toBe("approval");
    expect(d.narrow).not.toHaveBeenCalled();
    expect(d.onOverBudget).not.toHaveBeenCalled();
  });

  it("a read-only plan stopped only by the read-call cap is narrowed, not refused", async () => {
    const capped = { ...preview(500), blockers: ["手順2: 読み取りが上限（30回）を超えます。対象を絞ってください"], readLimit: { calls: 31, max: 30 } };
    const d = { ...deps([], [{ kind: "plan", plan: plan("narrow"), intro: "" }]), preview: vi.fn(async (p: PlannerPlan) => (p.summary === "a" ? capped : preview(500))) };
    const out = await runReadFlow({ msgId: "m1", plan: plan("a") }, d);
    expect(out).toMatchObject({ kind: "answer", turn: { msgId: "n1" } });
    expect(describeOverBudget(capped, CATALOG)).toMatch(/^読み取り回数が上限を超えました（31回目で停止・上限 30回）/);
  });

  it("any other blocker goes to the approval screen as before", async () => {
    const d = { ...deps([], []), preview: vi.fn(async () => ({ ...preview(500), blockers: ["手順1: params.id が決まっていません"] })) };
    expect((await runReadFlow({ msgId: "m1", plan: plan("a") }, d)).kind).toBe("approval");
    expect(d.narrow).not.toHaveBeenCalled();
  });

  describe("a where that matched nothing", () => {
    const empty = (p: PlannerPlan): Preview => ({
      ...preview(100),
      reads: [{ ...preview(100).reads[0]!, rows: 0, filtered: { from: 2, matched: p.summary === "fixed" ? 1 : 0 } }],
    });
    const run = (replies: PlannerReply[]) => {
      const d = { ...deps([], replies), preview: vi.fn(async (p: PlannerPlan) => empty(p)) };
      return { d, out: runReadFlow({ msgId: "m1", plan: plan("a") }, d) };
    };

    it("goes back to the planner and answers from the corrected plan", async () => {
      const { d, out } = run([{ kind: "plan", plan: plan("fixed"), intro: "" }]);
      expect(await out).toMatchObject({ kind: "answer", turn: { msgId: "n1" } });
      expect(d.narrow.mock.calls[0]![0]).toMatchObject({ why: "empty" });
    });

    it("the same plan back means 0件 is real: answer, never the confirm card", async () => {
      const { out } = run([{ kind: "plan", plan: plan("a"), intro: "" }]);
      expect((await out).kind).toBe("answer");
    });

    it("still empty after the rounds: answer as is", async () => {
      const { d, out } = run([1, 2, 3].map((i) => ({ kind: "plan" as const, plan: plan(`x${i}`), intro: "" })));
      expect((await out).kind).toBe("answer");
      expect(d.narrow).toHaveBeenCalledTimes(MAX_NARROW_ROUNDS);
    });

    it("names the step and its where for the planner", () => {
      const p: PlannerPlan = { type: "plan", summary: "", steps: [{ id: "t", op: "tasks.list", where: [{ field: "title", op: "contains", value: "北陸" }] }] };
      expect(describeEmptyMatch(empty(plan("a")), p)).toContain('- 手順 t（tasks.list）: 2件中 0件・条件 [{"field":"title","op":"contains","value":"北陸"}]');
    });
  });

  it("rounds: 0 (an operator-chosen narrowing) asks again instead of narrowing", async () => {
    const d = deps([BIG], []);
    const out = await runReadFlow({ msgId: "m1", plan: plan("a") }, d, { rounds: 0 });
    expect(out.kind).toBe("confirm");
    expect(d.narrow).not.toHaveBeenCalled();
  });
});

describe("describeOverBudget", () => {
  it("names the op, rows, size and the op's filters", () => {
    const text = describeOverBudget(preview(30 * 1024), CATALOG);
    expect(text).toContain("合計: 約 30.0 KB（上限 24.0 KB）");
    expect(text).toContain("- 手順 t（tasks.list・タスクの一覧を取得する）: 400行・約 30.0 KB・使える絞り込み: eventId, teamId, assigneeId, status");
  });
});
