// Real-path regression (症状#3 値=バー=横軸 / 症状#1 詳細編集→バー反映):
// The gantt read model DERIVES a bar window for a task that has only `dueAt` (real
// conference data seeds start_at = NULL). The detail panel must therefore seed 開始日
// from the bar's displayed startsAt — not show an empty field — so the value matches the
// bar and the axis. And any date edit must materialise BOTH edges so the saved task
// carries an explicit window (bar == value with no re-derivation drift).
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { task } from "@dub/types";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";

const dueOnly = (id: string): task.Task => ({
  id,
  eventId: "evt_1",
  title: id,
  description: null,
  status: "todo",
  priority: "medium",
  assigneeId: null,
  teamId: null,
  // start_at is NULL — exactly like the real conference seed (only due_at is set).
  startAt: null,
  dueAt: "2026-09-15T00:00:00.000Z",
  origin: "internal",
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  version: 2,
});

const val = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement).value;

describe("TaskDetailPanel — seeds date fields from the bar window (real-path 値=バー=軸)", () => {
  it("開始日 shows the bar's derived start (not empty) when startAt column is null", () => {
    render(
      <TaskDetailPanel
        task={dueOnly("t1")}
        users={[]}
        canWrite
        canDelete
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        // the gantt row derived a start (dueAt − 3d for medium) — the bar SHOWS this.
        barStartsAt={"2026-09-12T00:00:00.000Z"}
        barEndsAt={"2026-09-15T00:00:00.000Z"}
      />,
    );
    // 値(詳細) === バー(startsAt) === 軸: the field is populated from the bar, not blank.
    expect(val("fe4-detail-start")).toBe("2026-09-12");
    expect(val("fe4-detail-due")).toBe("2026-09-15");
  });

  it("editing 期日 materialises BOTH startAt+dueAt so the saved window is explicit (no drift)", () => {
    const onSave = vi.fn();
    render(
      <TaskDetailPanel
        task={dueOnly("t1")}
        users={[]}
        canWrite
        canDelete
        onSave={onSave}
        onDelete={() => {}}
        onClose={() => {}}
        barStartsAt={"2026-09-12T00:00:00.000Z"}
        barEndsAt={"2026-09-15T00:00:00.000Z"}
      />,
    );
    // move the 期日 out by changing the hidden native date input
    fireEvent.change(screen.getByTestId("fe4-detail-due"), { target: { value: "2026-09-29" } });
    fireEvent.click(screen.getByTestId("fe4-detail-save"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const [patch] = onSave.mock.calls[0]!;
    // BOTH edges are persisted: the derived start becomes explicit (so the bar keeps its
    // start instead of re-deriving to newDue−3d), and the new due is applied.
    expect(patch.startAt).toBe("2026-09-12T00:00:00.000Z");
    expect(patch.dueAt).toBe("2026-09-29T00:00:00.000Z");
  });

  it("PARENT: the rolled bar window WINS over a stale own start_at/due_at (症状#7 親子の値ズレ)", () => {
    // A work-package whose own columns hold a STALE window (08-12〜08-13) left over from
    // before it had children. The gantt bar shows the ROLLUP of its children (08-05〜08-22),
    // passed here as barStartsAt/barEndsAt. The detail must show the rollup — matching the bar
    // and the children — not the stale stored value.
    const staleParent: task.Task = {
      ...dueOnly("p"),
      startAt: "2026-08-12T00:00:00.000Z",
      dueAt: "2026-08-13T00:00:00.000Z",
    };
    render(
      <TaskDetailPanel
        task={staleParent}
        users={[]}
        canWrite
        canDelete
        hasChildren
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        barStartsAt={"2026-08-05T00:00:00.000Z"}
        barEndsAt={"2026-08-22T00:00:00.000Z"}
      />,
    );
    // 値(詳細) === バー(rollup) === 子の実データ, NOT the stale stored 08-12/08-13.
    expect(val("fe4-detail-start")).toBe("2026-08-05");
    expect(val("fe4-detail-due")).toBe("2026-08-22");
  });

  it("PARENT with no rolled window falls back to its own columns (no crash, best-available)", () => {
    const parentNoRoll: task.Task = {
      ...dueOnly("p"),
      startAt: "2026-08-12T00:00:00.000Z",
      dueAt: "2026-08-13T00:00:00.000Z",
    };
    render(
      <TaskDetailPanel
        task={parentNoRoll}
        users={[]}
        canWrite
        canDelete
        hasChildren
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        barStartsAt={null}
        barEndsAt={null}
      />,
    );
    expect(val("fe4-detail-start")).toBe("2026-08-12");
    expect(val("fe4-detail-due")).toBe("2026-08-13");
  });

  it("LEAF still prefers its own start_at over the bar (parent rule does not leak to leaves)", () => {
    const leaf: task.Task = {
      ...dueOnly("t1"),
      startAt: "2026-09-01T00:00:00.000Z",
      dueAt: "2026-09-15T00:00:00.000Z",
    };
    render(
      <TaskDetailPanel
        task={leaf}
        users={[]}
        canWrite
        canDelete
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        // a different (derived) bar window must NOT override the leaf's explicit columns.
        barStartsAt={"2026-09-05T00:00:00.000Z"}
        barEndsAt={"2026-09-20T00:00:00.000Z"}
      />,
    );
    expect(val("fe4-detail-start")).toBe("2026-09-01");
    expect(val("fe4-detail-due")).toBe("2026-09-15");
  });

  it("no date edit ⇒ the seeded window is NOT written back (clean save, no spurious dates)", () => {
    const onSave = vi.fn();
    render(
      <TaskDetailPanel
        task={dueOnly("t1")}
        users={[]}
        canWrite
        canDelete
        onSave={onSave}
        onDelete={() => {}}
        onClose={() => {}}
        barStartsAt={"2026-09-12T00:00:00.000Z"}
        barEndsAt={"2026-09-15T00:00:00.000Z"}
      />,
    );
    // change only the title, then save
    fireEvent.change(screen.getByTestId("fe4-detail-title"), { target: { value: "改題" } });
    fireEvent.click(screen.getByTestId("fe4-detail-save"));
    const [patch] = onSave.mock.calls[0]!;
    expect(patch.title).toBe("改題");
    expect(patch.startAt).toBeUndefined();
    expect(patch.dueAt).toBeUndefined();
  });
});
