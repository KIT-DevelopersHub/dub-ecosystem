import { describe, it, expect, beforeEach } from "vitest";
import { eventIdFromPath } from "./GlobalEventSwitcher.tsx";
import {
  SELECTED_EVENT_STORAGE_KEY,
  loadSelectedEvent,
  saveSelectedEvent,
} from "./selectedEventStore.ts";

describe("eventIdFromPath (current event from an event-scoped route)", () => {
  it("extracts the eventId from a tasks/gantt route", () => {
    expect(eventIdFromPath("/events/evt_1/tasks")).toBe("evt_1");
    expect(eventIdFromPath("/events/evt_1/tasks/gantt")).toBe("evt_1");
    expect(eventIdFromPath("/events/evt_9/tasks/tsk_3")).toBe("evt_9");
  });

  it("returns null off event-scoped routes (the switcher still renders, using the stored event)", () => {
    expect(eventIdFromPath("/mail")).toBeNull();
    expect(eventIdFromPath("/chat")).toBeNull();
    expect(eventIdFromPath("/admin/users")).toBeNull();
    expect(eventIdFromPath("/events/evt_1")).toBeNull(); // event detail, not tasks
    expect(eventIdFromPath("/gantt")).toBeNull(); // landing (no event param)
    expect(eventIdFromPath("/")).toBeNull();
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
