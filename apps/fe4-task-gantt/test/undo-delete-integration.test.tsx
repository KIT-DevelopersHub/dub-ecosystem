import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { identity, task } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

// Delete-undo (Ctrl/⌘-Z restores a deleted task) with a confirm gate. Delete is a heavy
// operation, so undoing it must NOT restore silently — it opens a ConfirmDialog first.
const EVENT = "evt_undo_del";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];
const mk = (id: string, title: string): task.Task => ({
  id, eventId: EVENT, title, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: "2026-08-20T00:00:00Z", origin: "internal",
  archivedAt: null, createdAt: `2026-08-0${id.length}T00:00:00Z`, updatedAt: "2026-08-01T00:00:00Z", version: 1,
});
const mkClient = () => new MockApiClient({ tasks: [mk("t1", "会場予約"), mk("t2", "登壇者調整")] });

/** Delete t1 through the detail panel and wait for its row to disappear. */
async function deleteT1() {
  fireEvent.click(await screen.findByTestId("fe4-gantt-row-t1"));
  const panel = await screen.findByTestId("fe4-detail-panel");
  fireEvent.click(within(panel).getByTestId("fe4-detail-delete"));
  // Delete confirm is the unified @dub/ui ConfirmDialog modal (rendered outside the
  // panel <aside>), not the old inline box — confirm via its [削除する] button.
  const confirm = await screen.findByTestId("fe4-confirm-delete");
  fireEvent.click(within(confirm).getByRole("button", { name: "削除する" }));
  await waitFor(() => expect(screen.queryByTestId("fe4-gantt-row-t1")).toBeNull());
}

describe("Delete undo with a confirm dialog (判断: 削除の取り消しは一段確認)", () => {
  it("Ctrl-Z after a delete opens a confirm dialog; canceling keeps the task deleted", async () => {
    render(<App client={mkClient()} eventId={EVENT} permissions={PERMS} />);
    await deleteT1();
    await waitFor(() => expect(screen.getByTestId("fe4-undo")).toBeEnabled());

    // Ctrl-Z does NOT restore immediately — it raises the confirm dialog.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    const dialog = await screen.findByTestId("fe4-undo-confirm");
    expect(within(dialog).getByText(/復元します/)).toBeInTheDocument();
    // the task is still gone while the dialog is open
    expect(screen.queryByTestId("fe4-gantt-row-t1")).toBeNull();

    // キャンセル closes the dialog and leaves the task deleted; the command is not consumed.
    fireEvent.click(within(dialog).getByText("キャンセル"));
    await waitFor(() => expect(screen.queryByTestId("fe4-undo-confirm")).toBeNull());
    expect(screen.queryByTestId("fe4-gantt-row-t1")).toBeNull();
    expect(screen.getByTestId("fe4-undo")).toBeEnabled(); // still undoable
  });

  it("confirming the dialog ([戻す]) restores the task (server-reflected) and enables redo", async () => {
    const client = mkClient();
    render(<App client={client} eventId={EVENT} permissions={PERMS} />);
    await deleteT1();
    await waitFor(() => expect(screen.getByTestId("fe4-undo")).toBeEnabled());

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    const dialog = await screen.findByTestId("fe4-undo-confirm");
    fireEvent.click(within(dialog).getByText("戻す"));

    // The row returns after a full reconcile (loadAll + refetchFresh reads the mock
    // server), so this proves the un-archive was persisted, not just optimistic.
    await waitFor(() => expect(screen.getByTestId("fe4-gantt-row-t1")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId("fe4-undo-confirm")).toBeNull());
    // undo consumed → redo now available to re-delete
    await waitFor(() => expect(screen.getByTestId("fe4-redo")).toBeEnabled());
  });

  it("the toolbar 元に戻す button gates behind the SAME confirm dialog (keyboard/button parity)", async () => {
    render(<App client={mkClient()} eventId={EVENT} permissions={PERMS} />);
    await deleteT1();
    await waitFor(() => expect(screen.getByTestId("fe4-undo")).toBeEnabled());

    fireEvent.click(screen.getByTestId("fe4-undo"));
    const dialog = await screen.findByTestId("fe4-undo-confirm");
    fireEvent.click(within(dialog).getByText("戻す"));
    await waitFor(() => expect(screen.getByTestId("fe4-gantt-row-t1")).toBeInTheDocument());
  });

  it("a non-delete undo (title edit) reverses instantly with NO confirm dialog", async () => {
    render(<App client={mkClient()} eventId={EVENT} permissions={PERMS} />);
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t1"));
    const panel = await screen.findByTestId("fe4-detail-panel");
    fireEvent.change(within(panel).getByTestId("fe4-detail-title"), { target: { value: "会場を確定する" } });
    fireEvent.click(within(panel).getByTestId("fe4-detail-save"));
    await waitFor(() =>
      expect(within(screen.getByTestId("fe4-gantt-row-t1")).getByText("会場を確定する")).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByTestId("fe4-undo")).toBeEnabled());

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    // no confirm dialog — the edit reverts straight away
    expect(screen.queryByTestId("fe4-undo-confirm")).toBeNull();
    await waitFor(() =>
      expect(within(screen.getByTestId("fe4-gantt-row-t1")).getByText("会場予約")).toBeInTheDocument(),
    );
  });
});
