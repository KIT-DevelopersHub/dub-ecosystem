// P11 delight UX — MyTaskList quick-complete checkbox: checkmark draw + row
// flash-then-fade on completion. See TaskCompleteCheck / app.module.css.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { task, common } from "@dub/types";
import { MyTaskList } from "../src/components/MyTaskList";
import { createUserCache } from "../src/domain/user-cache";

const mk = (over: Partial<task.Task> & { id: string }): task.Task => ({
  id: over.id,
  eventId: over.eventId ?? "evt_1",
  title: over.title ?? `T-${over.id}`,
  description: over.description ?? null,
  status: over.status ?? "todo",
  priority: over.priority ?? "medium",
  assigneeId: over.assigneeId ?? "usr_me",
  teamId: over.teamId ?? null,
  createdBy: over.createdBy ?? "usr_boss",
  dueAt: over.dueAt ?? null,
  origin: "internal",
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  version: 1,
});

const users = createUserCache([
  { id: "usr_me" as common.UserId, displayName: "自分", avatarUrl: null },
  { id: "usr_boss" as common.UserId, displayName: "上司", avatarUrl: null },
]);
const teamNames = new Map<common.TeamId, string>();

describe("MyTaskList — P11 quick-complete checkbox", () => {
  it("is omitted entirely when onComplete is not provided (additive, opt-in)", () => {
    const t = mk({ id: "t1" });
    render(<MyTaskList tasks={[t]} users={users} teamNames={teamNames} onSelect={() => {}} visibleCount={25} onShowMore={() => {}} />);
    expect(screen.queryByTestId("fe4-mytask-complete-t1")).toBeNull();
  });

  it("calls onComplete and does not also open the detail dialog (row onSelect)", () => {
    const onComplete = vi.fn();
    const onSelect = vi.fn();
    const t = mk({ id: "t2", status: "todo" });
    render(
      <MyTaskList
        tasks={[t]}
        users={users}
        teamNames={teamNames}
        onSelect={onSelect}
        onComplete={onComplete}
        visibleCount={25}
        onShowMore={() => {}}
      />,
    );
    const box = screen.getByTestId("fe4-mytask-complete-t2");
    expect(box).toHaveAttribute("aria-checked", "false");
    fireEvent.click(box);
    expect(onComplete).toHaveBeenCalledWith(t);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("draws the checkmark and flashes the row on completion, fading both out automatically", () => {
    vi.useFakeTimers();
    const t = mk({ id: "t3", status: "in_progress" });
    const { rerender } = render(
      <MyTaskList
        tasks={[t]}
        users={users}
        teamNames={teamNames}
        onSelect={() => {}}
        onComplete={() => {}}
        visibleCount={25}
        onShowMore={() => {}}
      />,
    );
    const box = screen.getByTestId("fe4-mytask-complete-t3");
    fireEvent.click(box);
    // Row flash class shows immediately.
    expect(screen.getByTestId("fe4-mytask-row-t3").className).toContain("rowJustCompleted");

    // The caller applies the optimistic status flip (mirrors MyTasksPage.onComplete).
    const done: task.Task = { ...t, status: "done" };
    rerender(
      <MyTaskList
        tasks={[done]}
        users={users}
        teamNames={teamNames}
        onSelect={() => {}}
        onComplete={() => {}}
        visibleCount={25}
        onShowMore={() => {}}
      />,
    );
    expect(box).toHaveAttribute("aria-checked", "true");
    expect(box).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByTestId("fe4-mytask-row-t3").className).not.toContain("rowJustCompleted");
    vi.useRealTimers();
  });

  it("shows a visible column header label so the checkbox is discoverable (not aria-only)", () => {
    const t = mk({ id: "t5" });
    render(
      <MyTaskList
        tasks={[t]}
        users={users}
        teamNames={teamNames}
        onSelect={() => {}}
        onComplete={vi.fn()}
        visibleCount={25}
        onShowMore={() => {}}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "完了" })).toBeInTheDocument();
  });

  it("disables the checkbox when the task cannot transition directly to done (blocked)", () => {
    const t = mk({ id: "t4", status: "blocked" }); // TASK_STATUS_TRANSITIONS.blocked has no "done"
    render(
      <MyTaskList
        tasks={[t]}
        users={users}
        teamNames={teamNames}
        onSelect={() => {}}
        onComplete={vi.fn()}
        visibleCount={25}
        onShowMore={() => {}}
      />,
    );
    expect(screen.getByTestId("fe4-mytask-complete-t4")).toBeDisabled();
  });
});
