// #375: a task with children cannot be deleted. The old UI showed an inline block message
// under the delete button, which was easy to miss. It now surfaces as a bottom-right
// warning toast (@dub/ui Toast, data-testid="toast-warning") — logic unchanged (onDelete
// is never called for a parent), only the presentation.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { task, identity } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

const EVENT = "evt_test";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];

const mk = (id: string, title: string, due: string): task.Task => ({
  id,
  eventId: EVENT,
  title,
  description: null,
  status: "todo",
  priority: "medium",
  assigneeId: "usr_a",
  teamId: null,
  startAt: null,
  dueAt: due,
  origin: "internal",
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  version: 1,
});

describe("#375 削除ブロックは右下トーストで表示（インライン廃止）", () => {
  it("clicking 削除 on a parent shows a warning toast and never deletes", async () => {
    const client = new MockApiClient({
      users: [{ id: "usr_a", displayName: "Alice", avatarUrl: null }],
      tasks: [
        mk("p", "本部設営", "2026-08-20T00:00:00Z"),
        mk("c1", "受付準備", "2026-08-18T00:00:00Z"),
      ],
      // c1 hangs under p → p is a work-package (has children) → delete must be blocked.
      hierarchy: {
        p: { parentTaskId: null, depth: 0 },
        c1: { parentTaskId: "p", depth: 1 },
      },
    });
    render(<App client={client} eventId={EVENT} permissions={PERMS} />);

    fireEvent.click(await screen.findByTestId("fe4-gantt-row-p"));
    await screen.findByTestId("fe4-detail-panel");
    fireEvent.click(screen.getByTestId("fe4-detail-delete"));

    // Bottom-right warning toast appears; no confirm dialog, no inline block.
    const toast = await screen.findByTestId("toast-warning");
    expect(toast.textContent).toMatch(/削除できません/);
    expect(toast.textContent).toMatch(/子タスク/);
    expect(screen.queryByTestId("fe4-confirm-delete")).toBeNull();
    expect(screen.queryByTestId("fe4-delete-blocked")).toBeNull();
    // The task is still there — nothing was deleted.
    await waitFor(() => expect(screen.getByTestId("fe4-gantt-row-p")).toBeInTheDocument());
  });
});
