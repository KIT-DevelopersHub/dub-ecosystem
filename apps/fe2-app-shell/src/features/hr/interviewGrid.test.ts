// コマ表の純粋ロジック: 日本時間の週・コマ・囲んだ範囲 → 足す/外す枠。
import { describe, expect, it } from "vitest";
import type { hrInterview } from "@dub/types";
import { cellRange, cellsBetween, cellState, jstWeekStart, modeFor, planChange, rowCount } from "./interviewGrid.ts";

const slot = (id: string, startAt: string, endAt: string, extra: Partial<hrInterview.InterviewSlot> = {}): hrInterview.InterviewSlot => ({
  id, startAt, endAt, interviewerId: "me", interviewerName: "", applicantId: null, applicantName: null, bookedAt: null, ...extra,
});

describe("interviewGrid", () => {
  it("starts the week on Monday in Japan time regardless of the browser zone", () => {
    // 2026-11-08 (日) 23:30 JST = 14:30 UTC → 週の始まりは 11-02 (月) 0:00 JST
    expect(new Date(jstWeekStart(Date.parse("2026-11-08T14:30:00Z"))).toISOString()).toBe("2026-11-01T15:00:00.000Z");
    // 2026-11-09 (月) 0:30 JST
    expect(new Date(jstWeekStart(Date.parse("2026-11-08T15:30:00Z"))).toISOString()).toBe("2026-11-08T15:00:00.000Z");
  });

  it("maps a cell to its JST time range", () => {
    const week = jstWeekStart(Date.parse("2026-11-10T00:00:00Z"));
    expect(rowCount(30)).toBe(24);
    const r = cellRange(week, 30, { day: 1, row: 10 }); // 火 14:00-14:30 JST
    expect(new Date(r.startMs).toISOString()).toBe("2026-11-10T05:00:00.000Z");
    expect(new Date(r.endMs).toISOString()).toBe("2026-11-10T05:30:00.000Z");
  });

  it("classifies cells and picks the drag mode from the first cell", () => {
    const slots = [
      slot("a", "2026-11-10T05:00:00Z", "2026-11-10T06:00:00Z"),
      slot("b", "2026-11-10T07:00:00Z", "2026-11-10T07:30:00Z", { applicantId: "app_1", applicantName: "山田" }),
      slot("c", "2026-11-10T08:00:00Z", "2026-11-10T08:30:00Z", { interviewerId: "other" }),
    ];
    const at = (iso: string) => ({ startMs: Date.parse(iso), endMs: Date.parse(iso) + 1_800_000 });
    const now = Date.parse("2026-11-09T00:00:00Z");
    expect(cellState(slots, "me", at("2026-11-10T05:30:00Z"), now).kind).toBe("mine"); // 60 分の枠の後半
    expect(cellState(slots, "me", at("2026-11-10T07:00:00Z"), now).kind).toBe("booked");
    expect(cellState(slots, "me", at("2026-11-10T08:00:00Z"), now)).toEqual({ kind: "free", others: 1 });
    expect(cellState(slots, "me", at("2026-11-08T08:00:00Z"), now).kind).toBe("past");
    expect(modeFor({ kind: "free", others: 0 })).toBe("add");
    expect(modeFor({ kind: "mine", slot: slots[0]! })).toBe("remove");
    expect(modeFor({ kind: "past" })).toBeNull();
  });

  it("plans only free cells to add, and each own slot once to remove", () => {
    const cells = cellsBetween({ day: 2, row: 3 }, { day: 1, row: 2 });
    expect(cells).toHaveLength(4);
    const mine = slot("a", "x", "y");
    const states = new Map([["1:2", { kind: "free", others: 0 }], ["1:3", { kind: "mine", slot: mine }], ["2:2", { kind: "mine", slot: mine }], ["2:3", { kind: "past" }]] as const);
    const stateOf = (c: { day: number; row: number }) => states.get(`${c.day}:${c.row}` as "1:2") as never;
    const rangeOf = (c: { day: number; row: number }) => ({ startMs: c.day * 1e6 + c.row * 1e3, endMs: 0 });
    expect(planChange("add", cells, stateOf, rangeOf, 30)).toEqual({ add: [{ startAt: new Date(1_002_000).toISOString(), durationMinutes: 30 }], remove: [] });
    expect(planChange("remove", cells, stateOf, rangeOf, 30)).toEqual({ add: [], remove: ["a"] });
  });
});
