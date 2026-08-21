// PR-A integration: assignee dropdown is populated from the org roster (1b), and
// a failed save surfaces a blocking ErrorDialog instead of silently doing nothing
// (4b/4c — no more "なぜか保存されない").
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import type { task, identity } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";
import { ApiError } from "../src/contracts/spa-shell";

const EVENT = "evt_test";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];

const mk = (id: string, title: string, due: string): task.Task => ({
  id, eventId: EVENT, title, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: due, origin: "internal",
  archivedAt: null, createdAt: "2026-08-02T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

// Roster members — none are assigned to a task, so the OLD behaviour showed only
// "未割当" in the dropdown.
const roster: identity.UserSummary[] = [
  { id: "usr_kume", displayName: "久米", avatarUrl: null },
  { id: "usr_araki", displayName: "荒木", avatarUrl: null },
];

function makeClient(): MockApiClient {
  return new MockApiClient({ users: roster, tasks: [mk("t2", "登壇者調整", "2026-08-20T00:00:00Z")] });
}

describe("assignee roster in the create modal (bug 1b)", () => {
  it("offers real members even when no task is assigned yet", async () => {
    render(<App client={makeClient()} eventId={EVENT} permissions={PERMS} />);
    await screen.findByTestId("fe4-gantt-row-t2");
    fireEvent.click(screen.getByTestId("fe4-create-open"));
    const modal = await screen.findByTestId("fe4-mytask-create-modal");
    const assignee = within(modal).getByTestId("fe4-mytask-create-assignee");
    await waitFor(() => expect(within(assignee).getByRole("option", { name: "久米" })).toBeInTheDocument());
    expect(within(assignee).getByRole("option", { name: "荒木" })).toBeInTheDocument();
    // and still keeps the 未割当 option
    expect(within(assignee).getByRole("option", { name: "未割当" })).toBeInTheDocument();
  });
});

describe("failed save surfaces the reason (bug 4b/4c)", () => {
  it("opens the ErrorDialog with the validation reason when a save fails", async () => {
    const client = makeClient();
    render(<App client={client} eventId={EVENT} permissions={PERMS} />);
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
    const panel = await screen.findByTestId("fe4-detail-panel");
    fireEvent.change(within(panel).getByTestId("fe4-detail-title"), { target: { value: "調整済み" } });
    // Next server call fails with a validation error → must be shown, not swallowed.
    client.failNext = new ApiError(400, {
      error: {
        code: "TASK_VALIDATION_FAILED",
        message: "入力内容を確認してください",
        retryable: false,
        details: [{ field: "period", reason: "required", message: "期間（時期）が未入力です" }],
      },
    });
    fireEvent.click(within(panel).getByTestId("fe4-detail-save"));
    const dialog = await screen.findByTestId("fe4-error-dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId("fe4-error-dialog-details")).toHaveTextContent("期間（時期）が未入力です");
    // dismiss clears it
    fireEvent.click(screen.getByTestId("fe4-error-dialog-close"));
    await waitFor(() => expect(screen.queryByTestId("fe4-error-dialog")).toBeNull());
  });
});
