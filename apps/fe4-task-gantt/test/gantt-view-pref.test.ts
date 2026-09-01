import { describe, it, expect, beforeEach } from "vitest";
import type { common } from "@dub/types";
import {
  clearViewPref,
  defaultViewPref,
  filterFromPref,
  loadShowCriticalPath,
  loadViewPref,
  prefFromView,
  saveShowCriticalPath,
  saveViewPref,
} from "../src/domain/gantt-view-pref";
import { emptyFilter } from "../src/domain/task-query";

const EVENT = "evt_test" as common.EventId;

describe("gantt view-pref persistence", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it("defaults to week zoom, no filter, all teams, archives hidden, critical path off", () => {
    const p = loadViewPref(EVENT);
    expect(p).toEqual({ zoom: "week", status: [], includeArchived: false, showCriticalPath: false });
  });

  it("persists all dimensions and reads them back", () => {
    saveViewPref(EVENT, {
      zoom: "day",
      status: ["todo", "in_progress"],
      teamId: "team_1" as common.TeamId,
      includeArchived: true,
      showCriticalPath: true,
    });
    expect(loadViewPref(EVENT)).toEqual({
      zoom: "day",
      status: ["todo", "in_progress"],
      teamId: "team_1",
      includeArchived: true,
      showCriticalPath: true,
    });
  });

  it("is scoped per event", () => {
    saveViewPref("evt_a" as common.EventId, { ...defaultViewPref(), zoom: "month" });
    expect(loadViewPref("evt_a" as common.EventId).zoom).toBe("month");
    expect(loadViewPref("evt_b" as common.EventId).zoom).toBe("week");
  });

  it("coerces garbage / partial payloads to defaults per field", () => {
    globalThis.localStorage?.setItem(
      "fe4:gantt-view-pref:evt_test",
      JSON.stringify({ zoom: "century", status: ["bogus", "done"], includeArchived: "yes" }),
    );
    expect(loadViewPref(EVENT)).toEqual({ zoom: "week", status: ["done"], includeArchived: false, showCriticalPath: false });
  });

  it("tolerates non-JSON storage", () => {
    globalThis.localStorage?.setItem("fe4:gantt-view-pref:evt_test", "not-json{");
    expect(loadViewPref(EVENT)).toEqual(defaultViewPref());
  });

  it("clearViewPref restores defaults", () => {
    saveViewPref(EVENT, { ...defaultViewPref(), zoom: "day" });
    clearViewPref(EVENT);
    expect(loadViewPref(EVENT)).toEqual(defaultViewPref());
  });

  it("filterFromPref seeds only the view dimensions onto emptyFilter", () => {
    const f = filterFromPref(EVENT, {
      zoom: "day",
      status: ["blocked"],
      teamId: "team_9" as common.TeamId,
      includeArchived: true,
      showCriticalPath: false,
    });
    expect(f).toEqual({
      ...emptyFilter(EVENT),
      status: ["blocked"],
      teamId: "team_9",
      includeArchived: true,
    });
  });

  it("prefFromView round-trips the view dimensions it owns (excludes showCriticalPath)", () => {
    const pref = {
      zoom: "month" as const,
      status: ["todo" as const],
      teamId: "team_3" as common.TeamId,
      includeArchived: true,
      showCriticalPath: true,
    };
    const f = filterFromPref(EVENT, pref);
    expect(prefFromView("month", f)).toEqual({
      zoom: "month",
      status: ["todo"],
      teamId: "team_3",
      includeArchived: true,
    });
  });

  it("omits teamId when 全体表示 (all teams)", () => {
    saveViewPref(EVENT, { zoom: "week", status: [], includeArchived: false, showCriticalPath: false });
    const p = loadViewPref(EVENT);
    expect("teamId" in p).toBe(false);
  });
});

describe("showCriticalPath toggle persistence", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it("defaults to false when nothing is stored", () => {
    expect(loadShowCriticalPath(EVENT)).toBe(false);
  });

  it("saves and reads back the toggle per event", () => {
    saveShowCriticalPath(EVENT, true);
    expect(loadShowCriticalPath(EVENT)).toBe(true);
    expect(loadShowCriticalPath("evt_other" as common.EventId)).toBe(false);
  });

  it("does NOT clobber the other view dimensions (read-modify-write)", () => {
    saveViewPref(EVENT, {
      zoom: "day",
      status: ["blocked"],
      teamId: "team_7" as common.TeamId,
      includeArchived: true,
      showCriticalPath: false,
    });
    saveShowCriticalPath(EVENT, true);
    expect(loadViewPref(EVENT)).toEqual({
      zoom: "day",
      status: ["blocked"],
      teamId: "team_7",
      includeArchived: true,
      showCriticalPath: true,
    });
  });

  it("survives a subsequent zoom/filter write-through (prefFromView merge)", () => {
    saveShowCriticalPath(EVENT, true);
    // simulate TaskWorkspacePage's write-through merging over the stored pref
    saveViewPref(EVENT, { ...loadViewPref(EVENT), ...prefFromView("month", { ...emptyFilter(EVENT), status: [] }) });
    expect(loadShowCriticalPath(EVENT)).toBe(true);
    expect(loadViewPref(EVENT).zoom).toBe("month");
  });
});
