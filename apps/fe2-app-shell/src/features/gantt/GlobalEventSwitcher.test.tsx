import { describe, it, expect, beforeEach } from "vitest";
import { isGanttContext } from "./GlobalEventSwitcher.tsx";
import {
  SELECTED_EVENT_STORAGE_KEY,
  loadSelectedEvent,
  saveSelectedEvent,
} from "./selectedEventStore.ts";

describe("isGanttContext (global event switcher visibility)", () => {
  it("shows on the gantt landing", () => {
    expect(isGanttContext("/gantt")).toBe(true);
  });

  it("shows on an event-scoped tasks/gantt route", () => {
    expect(isGanttContext("/events/evt_1/tasks")).toBe(true);
    expect(isGanttContext("/events/evt_1/tasks/gantt")).toBe(true);
    expect(isGanttContext("/events/evt_1/tasks/tsk_9")).toBe(true);
  });

  it("hides on unrelated app routes (mail / chat / roster / event detail)", () => {
    expect(isGanttContext("/mail")).toBe(false);
    expect(isGanttContext("/chat")).toBe(false);
    expect(isGanttContext("/admin/users")).toBe(false);
    expect(isGanttContext("/events/evt_1")).toBe(false); // event detail, not tasks
    expect(isGanttContext("/")).toBe(false);
  });
});

describe("selectedEventStore persistence", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(loadSelectedEvent()).toBeNull();
  });

  it("persists and reads back the selected event", () => {
    saveSelectedEvent("evt_3");
    expect(loadSelectedEvent()).toBe("evt_3");
    expect(globalThis.localStorage?.getItem(SELECTED_EVENT_STORAGE_KEY)).toBe("evt_3");
  });

  it("ignores blank ids (treated as no selection)", () => {
    saveSelectedEvent("   ");
    expect(loadSelectedEvent()).toBeNull();
  });
});
