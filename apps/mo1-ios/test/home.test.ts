import { describe, it, expect } from "vitest";
import type { mobile, task } from "@dub/types";
import { buildHomeViewState } from "../src/home.js";

function t(id: string, status: task.TaskStatus): task.TaskSummary {
  return { id, title: id, status, assigneeId: "u1" };
}

describe("home view-state reducer (design §2-1 S2)", () => {
  it("keeps only open tasks in the preview and caps them", () => {
    const res: mobile.MobileHomeResponse = {
      upcomingEvents: [{ id: "evt_1", title: "Conf", phase: "planning", startsAt: null }],
      myTasks: [t("a", "todo"), t("b", "done"), t("c", "in_progress"), t("d", "blocked"), t("e", "cancelled")],
      unreadCount: 4,
    };
    const state = buildHomeViewState(res, 2);
    expect(state.todayTasks.map((x) => x.id)).toEqual(["a", "c"]); // done/cancelled dropped, capped at 2
    expect(state.hasUnread).toBe(true);
    expect(state.isEmpty).toBe(false);
  });

  it("is empty when there are no events and no open tasks", () => {
    const res: mobile.MobileHomeResponse = {
      upcomingEvents: [],
      myTasks: [t("a", "done")],
      unreadCount: 0,
    };
    const state = buildHomeViewState(res);
    expect(state.isEmpty).toBe(true);
    expect(state.hasUnread).toBe(false);
  });
});
