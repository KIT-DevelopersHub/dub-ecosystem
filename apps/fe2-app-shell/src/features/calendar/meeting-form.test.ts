import { describe, expect, it } from "vitest";
import type { meeting } from "@dub/types";
import {
  emptyMeetingForm,
  isMeetingTargetVisible,
  parseMeetingTargetChoices,
  toMeetingRequest,
  validateMeetingForm,
  type MeetingFormValues,
} from "./meeting-form";

const valid: MeetingFormValues = {
  title: "  全体定例 ",
  targetId: "all",
  date: "2026-10-19",
  time: "21:00",
  durationMinutes: 60,
  recurrence: "weekly",
  until: "",
  description: "",
};

describe("validateMeetingForm", () => {
  it("accepts a complete form", () => {
    expect(validateMeetingForm(valid)).toEqual({});
  });

  it("flags missing title / target / date / time", () => {
    const e = validateMeetingForm({ ...valid, title: " ", targetId: "", date: "", time: "" });
    expect(Object.keys(e).sort()).toEqual(["date", "targetId", "time", "title"]);
  });

  it("rejects an end date before the start, only when repeating", () => {
    expect(validateMeetingForm({ ...valid, until: "2026-10-01" }).until).toBeDefined();
    expect(validateMeetingForm({ ...valid, recurrence: "none", until: "2026-10-01" }).until).toBeUndefined();
  });
});

describe("toMeetingRequest", () => {
  it("sends startsAt as the UTC instant of the JST date + time", () => {
    expect(toMeetingRequest(valid)).toEqual({
      title: "全体定例",
      description: null,
      targetId: "all",
      startsAt: "2026-10-19T12:00:00.000Z",
      durationMinutes: 60,
      recurrence: "weekly",
      until: null,
    });
  });

  it("keeps until only for repeating meetings", () => {
    expect(toMeetingRequest({ ...valid, until: "2026-12-31" }).until).toBe("2026-12-31");
    expect(toMeetingRequest({ ...valid, recurrence: "none", until: "2026-12-31" }).until).toBeNull();
  });

  it("an early-morning JST start lands on the previous UTC day", () => {
    expect(toMeetingRequest({ ...valid, date: "2026-10-20", time: "08:00" }).startsAt).toBe("2026-10-19T23:00:00.000Z");
  });

  it("new form defaults to 全体 / 21:00 / 60 min / 毎週 on today's JST date", () => {
    const f = emptyMeetingForm(new Date("2026-10-13T16:00:00Z")); // 10/14 01:00 JST
    expect(f).toMatchObject({ targetId: "all", time: "21:00", durationMinutes: 60, recurrence: "weekly", date: "2026-10-14" });
  });
});

describe("表示するカレンダー filter", () => {
  const targets: meeting.MeetingTarget[] = [
    { id: "all", name: "全体", memberCount: 9, isMine: false },
    { id: "role_lead", name: "統括", memberCount: 2, isMine: true },
    { id: "role_member", name: "member", memberCount: 4, isMine: false },
  ];

  const visible = (choices: Record<string, boolean>, t: typeof targets | null | "error" = targets) =>
    ["all", "role_lead", "role_member", "role_gone"].filter((id) => isMeetingTargetVisible(id, choices, t));

  it("defaults to 全体 (always) + the caller's own targets; a deleted role stays visible", () => {
    expect(visible({})).toEqual(["all", "role_lead", "role_gone"]);
  });

  it("an explicit choice wins over the default, and new targets fall back to the default", () => {
    expect(visible({ all: false, role_member: true })).toEqual(["role_lead", "role_member", "role_gone"]);
  });

  it("while targets load only 全体 / chosen ones show (nothing flashes then vanishes); on error all show", () => {
    expect(visible({}, null)).toEqual(["all"]);
    expect(visible({ role_lead: true }, null)).toEqual(["all", "role_lead"]);
    expect(visible({}, "error")).toEqual(["all", "role_lead", "role_member", "role_gone"]);
  });

  it("a target the caller made meetings for shows by default, even if not theirs (unless unticked)", () => {
    const mine = new Set(["role_member"]);
    const ids = ["all", "role_lead", "role_member"];
    expect(ids.filter((id) => isMeetingTargetVisible(id, {}, targets, mine))).toEqual(ids);
    expect(ids.filter((id) => isMeetingTargetVisible(id, {}, null, mine))).toEqual(["all", "role_member"]);
    expect(isMeetingTargetVisible("role_member", { role_member: false }, targets, mine)).toBe(false);
  });

  it("parses only boolean choices", () => {
    expect(parseMeetingTargetChoices({ a: true, b: "x", c: false })).toEqual({ a: true, c: false });
    expect(parseMeetingTargetChoices(["a"])).toEqual({});
    expect(parseMeetingTargetChoices(null)).toEqual({});
  });
});
