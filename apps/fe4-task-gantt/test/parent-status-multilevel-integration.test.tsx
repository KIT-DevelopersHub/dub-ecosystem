import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { task, identity } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

// End-to-end regression for the 3 reported bugs together, across a REAL 3-level WBS
// (root -> mid -> leaves), through the actual TaskWorkspacePage wiring (not just the
// pure child-progress function):
//   1) the STATUS DROPDOWN (not just the bar colour) reflects the aggregated result
//   2) the aggregated value shown is the PLURALITY (most common) leaf status
//   3) the aggregation is RECURSIVE — "root" has only ONE direct child ("mid"), yet its
//      displayed status/bar tracks the THREE leaves two levels down
//   4) changing a leaf's status re-aggregates and re-renders every ancestor the same
//      render pass (optimistic), without needing a manual refresh

const EVENT = "evt_test";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];

const mk = (id: string, title: string, status: task.TaskStatus): task.Task => ({
  id,
  eventId: EVENT,
  title,
  description: null,
  status,
  priority: "medium",
  assigneeId: null,
  teamId: null,
  dueAt: "2026-08-20T00:00:00Z",
  origin: "internal",
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  version: 1,
});

function seedClient(): MockApiClient {
  return new MockApiClient({
    tasks: [
      mk("root", "root", "todo"),
      mk("mid", "mid", "todo"),
      mk("leaf1", "leaf1", "todo"),
      mk("leaf2", "leaf2", "todo"),
      mk("leaf3", "leaf3", "todo"),
    ],
    hierarchy: {
      mid: { parentTaskId: "root", depth: 1 },
      leaf1: { parentTaskId: "mid", depth: 2 },
      leaf2: { parentTaskId: "mid", depth: 2 },
      leaf3: { parentTaskId: "mid", depth: 2 },
    },
  });
}

const renderApp = () => render(<App client={seedClient()} eventId={EVENT} permissions={PERMS} />);

/** Set a task's status through its OWN detail panel and wait for the autosave to land
 *  (data-state="saved"), then close it — so the optimistic store update is committed
 *  before the next assertion reads a DIFFERENT task's aggregated view. */
async function setStatusAndWaitSaved(taskId: string, status: task.TaskStatus) {
  fireEvent.click(await screen.findByTestId(`fe4-gantt-row-${taskId}`));
  const panel = await screen.findByTestId("fe4-detail-panel");
  fireEvent.change(within(panel).getByTestId("fe4-detail-status"), { target: { value: status } });
  await waitFor(
    () => expect(within(panel).getByTestId("fe4-detail-save-status")).toHaveAttribute("data-state", "saved"),
    { timeout: 2000 },
  );
  fireEvent.click(within(panel).getByTestId("fe4-detail-close"));
}

describe("親タスクのステータス集計 — 多階層(root>mid>leaf)を実ワークスペースで通す", () => {
  it("葉(leaf)を2/3 完了にすると、2階層上のrootのドロップダウン/バーが多数決(完了)に追従する", async () => {
    renderApp();

    // Expand root -> mid -> leaves (all rows start collapsed).
    fireEvent.click(await screen.findByTestId("fe4-gantt-toggle-root"));
    fireEvent.click(await screen.findByTestId("fe4-gantt-toggle-mid"));
    await screen.findByTestId("fe4-gantt-row-leaf1");

    // All three leaves start todo — root's aggregate should read todo, disabled (locked).
    fireEvent.click(screen.getByTestId("fe4-gantt-row-root"));
    let rootPanel = await screen.findByTestId("fe4-detail-panel");
    let rootStatus = within(rootPanel).getByTestId("fe4-detail-status") as HTMLSelectElement;
    expect(rootStatus.value).toBe("todo");
    expect(rootStatus.disabled).toBe(true);
    expect(within(rootPanel).getByTestId("fe4-detail-status-locked")).toBeInTheDocument();
    fireEvent.click(within(rootPanel).getByTestId("fe4-detail-close"));

    // Flip 2 of the 3 LEAVES (two levels below root) to done — majority becomes done.
    await setStatusAndWaitSaved("leaf1", "done");
    await setStatusAndWaitSaved("leaf2", "done");

    // root has only ONE direct child ("mid"); this proves the aggregate is recursive,
    // not capped at direct children — it reads the 2/3 done from the LEAVES.
    const rootBar = screen.getByTestId("fe4-gantt-bar-root");
    expect(rootBar).toHaveAttribute("data-child-done", "2");
    expect(rootBar).toHaveAttribute("data-child-total", "3");

    fireEvent.click(screen.getByTestId("fe4-gantt-row-root"));
    rootPanel = await screen.findByTestId("fe4-detail-panel");
    rootStatus = within(rootPanel).getByTestId("fe4-detail-status") as HTMLSelectElement;
    // Bug #1 (dropdown stuck) + #2 (majority) + #3 (recursive, 2 levels) all verified here:
    expect(rootStatus.value).toBe("done");
    expect(rootStatus.disabled).toBe(true);

    // The intermediate node ("mid") also re-aggregates from the SAME leaves (any depth).
    fireEvent.click(within(rootPanel).getByTestId("fe4-detail-close"));
    fireEvent.click(screen.getByTestId("fe4-gantt-row-mid"));
    const midPanel = await screen.findByTestId("fe4-detail-panel");
    expect((within(midPanel).getByTestId("fe4-detail-status") as HTMLSelectElement).value).toBe("done");
  });
});
