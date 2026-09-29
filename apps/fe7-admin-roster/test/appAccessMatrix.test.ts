import { describe, it, expect } from "vitest";
import { appRegistry } from "@dub/types";
import {
  appAccessRows,
  appAccessLevel,
  appAccessSummary,
  setAppAccessLevel,
  toggleAppEnabled,
  type AppAccessRow,
} from "../src/lib/appAccessMatrix";

const rowFor = (id: string): AppAccessRow => appAccessRows().find((r) => r.id === id)!;

describe("appAccessMatrix — per-app access folding", () => {
  it("exposes one row per manifest app, in launcher order, with its view/edit keys", () => {
    const rows = appAccessRows();
    expect(rows.map((r) => r.id)).toEqual(appRegistry.APP_IDS);
    const gantt = rowFor("gantt");
    expect(gantt.view).toBe("app:gantt:view");
    expect(gantt.edit).toBe("app:gantt:edit");
    expect(rowFor("usage").openToAll).toBe(true);
    expect(rowFor("events").openToAll).toBe(false);
  });

  it("reads level off/view/edit from the selected set (edit implies view)", () => {
    const gantt = rowFor("gantt");
    expect(appAccessLevel([], gantt)).toBe("off");
    expect(appAccessLevel(["app:gantt:view"], gantt)).toBe("view");
    expect(appAccessLevel(["app:gantt:view", "app:gantt:edit"], gantt)).toBe("edit");
    // edit key alone still resolves to edit (view is implied)
    expect(appAccessLevel(["app:gantt:edit"], gantt)).toBe("edit");
  });

  it("setAppAccessLevel writes a self-consistent set (edit co-carries view; off clears both)", () => {
    const gantt = rowFor("gantt");
    expect(setAppAccessLevel([], gantt, "view")).toEqual(["app:gantt:view"]);
    expect(setAppAccessLevel([], gantt, "edit")).toEqual(["app:gantt:edit", "app:gantt:view"].sort());
    expect(setAppAccessLevel(["app:gantt:view", "app:gantt:edit"], gantt, "off")).toEqual([]);
    // does not disturb other apps' keys
    expect(setAppAccessLevel(["app:mail:view"], gantt, "view").sort()).toEqual(["app:gantt:view", "app:mail:view"].sort());
  });

  it("toggleAppEnabled flips off<->view without touching edit level semantics", () => {
    const p = rowFor("participation");
    expect(toggleAppEnabled([], p, true)).toEqual(["app:participation:view"]);
    expect(toggleAppEnabled(["app:participation:view", "app:participation:edit"], p, false)).toEqual([]);
  });

  it("gantt and 参加届 toggle INDEPENDENTLY of tasks/members (the bug this fixes)", () => {
    // enabling gantt must not grant tasks, and vice-versa
    const withGantt = setAppAccessLevel([], rowFor("gantt"), "view");
    expect(appAccessLevel(withGantt, rowFor("tasks"))).toBe("off");
    const withParticipation = setAppAccessLevel([], rowFor("participation"), "view");
    expect(appAccessLevel(withParticipation, rowFor("members"))).toBe("off");
  });

  it("summary counts enabled apps out of total", () => {
    expect(appAccessSummary([])).toEqual({ enabled: 0, total: appRegistry.APP_IDS.length });
    expect(appAccessSummary(["app:mail:view", "app:gantt:edit"]).enabled).toBe(2);
  });
});
