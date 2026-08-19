// 症状#7 (stale根絶): opening a task's 詳細 must ALWAYS reflect server truth. A parent-bar
// drag (or any out-of-band change) mutates a task server-side; the cached gantt read model
// and task store still hold the pre-change copy, so a detail opened afterwards used to show
// the OLD value. The workspace now forces a fresh, no-cache refetch of both sources on every
// open and re-seeds the panel once the authoritative values land.
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

const dueValue = () => (screen.getByTestId("fe4-detail-due") as HTMLInputElement).value;

describe("TaskWorkspacePage — 詳細を開くたびサーバーから refetch (症状#7)", () => {
  it("re-opening a task detail surfaces a server-side date change (never the stale cache)", async () => {
    const client = new MockApiClient({
      users: [{ id: "usr_a", displayName: "Alice", avatarUrl: null }],
      tasks: [mk("t2", "登壇者調整", "2026-08-20T00:00:00Z")],
    });
    render(<App client={client} eventId={EVENT} permissions={PERMS} />);

    // First open shows the seeded due.
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
    await screen.findByTestId("fe4-detail-panel");
    await waitFor(() => expect(dueValue()).toBe("2026-08-20"));

    // Close, then change the task ON THE SERVER only — the app's react-query cache and task
    // store still hold due=08-20 (exactly the post-drag stale situation).
    fireEvent.click(screen.getByTestId("fe4-detail-close"));
    await waitFor(() => expect(screen.queryByTestId("fe4-detail-panel")).toBeNull());
    await client.tasks.patch("/t2", { version: 1, dueAt: "2026-09-30T00:00:00.000Z" });

    // Re-open: the refetch-on-open must pull the fresh due and re-seed the field.
    fireEvent.click(screen.getByTestId("fe4-gantt-row-t2"));
    await screen.findByTestId("fe4-detail-panel");
    await waitFor(() => expect(dueValue()).toBe("2026-09-30"));
  });
});
