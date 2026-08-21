import { describe, it, expect, beforeEach } from "vitest";
import type { common } from "@dub/types";
import {
  addSortKey,
  availableKeys,
  defaultSortState,
  loadGanttSort,
  moveSortKey,
  removeSortKey,
  saveGanttSort,
  setManual,
  setSortKeyDir,
  setSortKeyField,
  summarizeSort,
  type GanttSortState,
} from "../src/domain/gantt-sort-pref";

const EVT = "evt_1" as common.EventId;

describe("gantt-sort-pref — pure reducers", () => {
  it("addSortKey appends an ascending key and leaves manual mode; keys stay unique", () => {
    let s = defaultSortState(); // { manual: true, keys: [] }
    s = addSortKey(s, "team");
    expect(s).toEqual({ manual: false, keys: [{ key: "team", dir: "asc" }] });
    s = addSortKey(s, "priority");
    expect(s.keys.map((k) => k.key)).toEqual(["team", "priority"]);
    // adding a duplicate key is a no-op on the list
    s = addSortKey(s, "team");
    expect(s.keys.map((k) => k.key)).toEqual(["team", "priority"]);
  });

  it("availableKeys excludes already-used keys", () => {
    const s: GanttSortState = { manual: false, keys: [{ key: "team", dir: "asc" }] };
    expect(availableKeys(s)).toEqual(["priority", "schedule"]);
  });

  it("moveSortKey reorders priority; out-of-range is a no-op", () => {
    const s: GanttSortState = {
      manual: false,
      keys: [
        { key: "team", dir: "asc" },
        { key: "priority", dir: "asc" },
        { key: "schedule", dir: "asc" },
      ],
    };
    expect(moveSortKey(s, 2, -1).keys.map((k) => k.key)).toEqual(["team", "schedule", "priority"]);
    expect(moveSortKey(s, 0, -1)).toBe(s); // already at top
    expect(moveSortKey(s, 2, 1)).toBe(s); // already at bottom
  });

  it("setSortKeyField swaps the key but refuses a duplicate", () => {
    const s: GanttSortState = {
      manual: false,
      keys: [
        { key: "team", dir: "asc" },
        { key: "priority", dir: "asc" },
      ],
    };
    expect(setSortKeyField(s, 0, "schedule").keys[0]!.key).toBe("schedule");
    // "priority" is already used by index 1 → no-op
    expect(setSortKeyField(s, 0, "priority")).toBe(s);
  });

  it("setSortKeyDir flips direction", () => {
    const s: GanttSortState = { manual: false, keys: [{ key: "team", dir: "asc" }] };
    expect(setSortKeyDir(s, 0, "desc").keys[0]!.dir).toBe("desc");
  });

  it("removeSortKey drops a condition and returns to manual when the list empties", () => {
    const s: GanttSortState = {
      manual: false,
      keys: [
        { key: "team", dir: "asc" },
        { key: "priority", dir: "asc" },
      ],
    };
    expect(removeSortKey(s, 0).keys.map((k) => k.key)).toEqual(["priority"]);
    const one: GanttSortState = { manual: false, keys: [{ key: "team", dir: "asc" }] };
    expect(removeSortKey(one, 0)).toEqual({ manual: true, keys: [] });
  });

  it("setManual preserves the key list and seeds one when leaving an empty auto state", () => {
    const built: GanttSortState = { manual: false, keys: [{ key: "team", dir: "asc" }] };
    expect(setManual(built, true)).toEqual({ manual: true, keys: [{ key: "team", dir: "asc" }] });
    expect(setManual({ manual: true, keys: [] }, false).keys.length).toBe(1);
  });

  it("summarizeSort renders the key chain / 手動", () => {
    expect(summarizeSort({ manual: true, keys: [] })).toBe("手動（ドラッグ）");
    expect(
      summarizeSort({
        manual: false,
        keys: [
          { key: "team", dir: "asc" },
          { key: "priority", dir: "asc" },
        ],
      }),
    ).toBe("チーム順 → 重要度順");
  });
});

describe("gantt-sort-pref — persistence + legacy migration", () => {
  beforeEach(() => globalThis.localStorage?.clear());

  it("round-trips a multi-key state through localStorage", () => {
    const s: GanttSortState = {
      manual: false,
      keys: [
        { key: "team", dir: "asc" },
        { key: "priority", dir: "desc" },
      ],
    };
    saveGanttSort(EVT, s);
    expect(loadGanttSort(EVT)).toEqual(s);
  });

  it("defaults to manual when nothing is stored", () => {
    expect(loadGanttSort(EVT)).toEqual(defaultSortState());
  });

  it("migrates the legacy single-string value (#303) forward", () => {
    // old format stored the bare GanttSortMode string
    globalThis.localStorage!.setItem(`fe4:gantt-sort:${EVT}`, "priority");
    expect(loadGanttSort(EVT)).toEqual({ manual: false, keys: [{ key: "priority", dir: "asc" }] });
    globalThis.localStorage!.setItem(`fe4:gantt-sort:${EVT}`, "manual");
    expect(loadGanttSort(EVT)).toEqual({ manual: true, keys: [] });
  });

  it("tolerates corrupt stored JSON by falling back to the default", () => {
    globalThis.localStorage!.setItem(`fe4:gantt-sort:${EVT}`, '{"manual":false,"keys":"nope"}');
    expect(loadGanttSort(EVT)).toEqual(defaultSortState());
  });
});
