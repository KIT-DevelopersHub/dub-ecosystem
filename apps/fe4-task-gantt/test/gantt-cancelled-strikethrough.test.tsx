import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { task, identity } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

// Regression for: 「子タスクを中止(cancelled)にした時の取り消し線が子タスクにしか付か
// ない。親タスクにも反映してほしい」(判断30/46 の親ステータス集計に乗せて) — a WBS
// parent/grandparent whose subtree's AGGREGATED leaf-status mix (effectiveChildProgressById
// / effectiveStatusById in GanttView.tsx) becomes "cancelled" must show the SAME
// strikethrough style a cancelled leaf gets, on BOTH its bar label and its left-pane row
// title — at every level of a multi-level (root > mid > leaf) hierarchy — never only on
// the leaf that is actually stored as cancelled.

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

/** Same helper as parent-status-multilevel-integration.test.tsx: drive a status change
 *  through the task's OWN detail panel and wait for the optimistic autosave to commit. */
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

describe("中止(cancelled)の取り消し線 — 親・祖父タスクへの多階層伝播", () => {
  it("葉の過半数を中止にすると、mid・rootのバー/行タイトルにも取り消し線が付く", async () => {
    renderApp();

    // Expand root -> mid -> leaves (all rows start collapsed).
    fireEvent.click(await screen.findByTestId("fe4-gantt-toggle-root"));
    fireEvent.click(await screen.findByTestId("fe4-gantt-toggle-mid"));
    await screen.findByTestId("fe4-gantt-row-leaf1");

    // Before: nothing is cancelled — no strikethrough anywhere.
    expect(screen.getByTestId("fe4-gantt-row-title-root").className).not.toMatch(/tlRowNameCancelled/);
    expect(screen.getByTestId("fe4-gantt-bar-root").className).not.toMatch(/barCancelledLabel/);

    // Cancel 2 of the 3 LEAVES (two levels below root) — majority becomes "cancelled"
    // for BOTH the intermediate ("mid") and the root, recursively (leaf3 stays todo).
    await setStatusAndWaitSaved("leaf1", "cancelled");
    await setStatusAndWaitSaved("leaf2", "cancelled");

    // ---- leaf itself: unchanged existing behaviour (own status IS cancelled) ----
    expect(screen.getByTestId("fe4-gantt-bar-leaf1").className).toMatch(/barCancelled_/);
    expect(screen.getByTestId("fe4-gantt-row-title-leaf1").className).toMatch(/tlRowNameCancelled/);
    // leaf3 was never touched — must stay plain.
    expect(screen.getByTestId("fe4-gantt-row-title-leaf3").className).not.toMatch(/tlRowNameCancelled/);

    // ---- mid (direct parent of the 3 leaves): must now ALSO be struck through ----
    const midBar = screen.getByTestId("fe4-gantt-bar-mid");
    expect(midBar).toHaveAttribute("data-child-done", "0");
    expect(midBar.className).toMatch(/barCancelledLabel/);
    expect(screen.getByTestId("fe4-gantt-row-title-mid").className).toMatch(/tlRowNameCancelled/);

    // ---- root (GRANDparent — 2 levels above the leaves, only ONE direct child "mid") ----
    // proves the strikethrough propagation is recursive, not capped at direct children.
    const rootBar = screen.getByTestId("fe4-gantt-bar-root");
    expect(rootBar).toHaveAttribute("data-child-total", "3");
    expect(rootBar.className).toMatch(/barCancelledLabel/);
    expect(screen.getByTestId("fe4-gantt-row-title-root").className).toMatch(/tlRowNameCancelled/);

    // The parent's segmented-track colouring (判断30/46) must stay intact — the fix only
    // ADDS the label strikethrough, it must not replace the neutral "barParent" track.
    expect(rootBar.className).toMatch(/barParent_/);

    // Sanity: the detail panel's dropdown itself agrees (aggregation math, independently
    // regression-tested in parent-status-multilevel-integration.test.tsx).
    fireEvent.click(screen.getByTestId("fe4-gantt-row-root"));
    const rootPanel = await screen.findByTestId("fe4-detail-panel");
    expect((within(rootPanel).getByTestId("fe4-detail-status") as HTMLSelectElement).value).toBe("cancelled");
  });
});
