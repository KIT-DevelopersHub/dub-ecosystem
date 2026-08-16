import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { identity, task } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

const EVENT = "evt_undo";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];
const mk = (id: string, title: string): task.Task => ({
  id, eventId: EVENT, title, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: "2026-08-20T00:00:00Z", origin: "internal",
  archivedAt: null, createdAt: `2026-08-0${id.length}T00:00:00Z`, updatedAt: "2026-08-01T00:00:00Z", version: 1,
});
const client = () => new MockApiClient({ tasks: [mk("t1", "会場予約"), mk("t2", "登壇者調整")] });

describe("Undo wiring in the gantt workspace (判断57)", () => {
  it("undo is disabled with empty history and Ctrl-Z is a harmless no-op", async () => {
    render(<App client={client()} eventId={EVENT} permissions={PERMS} />);
    await screen.findByTestId("fe4-gantt-row-t1");
    expect(screen.getByTestId("fe4-undo")).toBeDisabled();
    expect(screen.getByTestId("fe4-redo")).toBeDisabled();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true }); // nothing to undo
    expect(screen.queryByTestId("fe4-error-banner")).toBeNull();
    expect(screen.getByTestId("fe4-undo")).toBeDisabled();
  });

  it("a dependency add can be undone (enables undo, then Ctrl-Z removes the arrow)", async () => {
    render(<App client={client()} eventId={EVENT} permissions={PERMS} />);
    // add t1 as a predecessor of t2 from the detail panel
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
    const panel = await screen.findByTestId("fe4-detail-panel");
    const input = within(panel).getByTestId("fe4-detail-deps-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "会場" } });
    fireEvent.mouseDown(within(panel).getByTestId("fe4-detail-deps-opt-t1"));
    fireEvent.click(within(panel).getByTestId("fe4-detail-save"));

    // the dependency arrow is drawn and undo becomes available
    expect(await screen.findByTestId("fe4-gantt-dep-t1->t2")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("fe4-undo")).toBeEnabled());

    // Ctrl-Z restores the previous state (no predecessor) — the arrow disappears
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId("fe4-gantt-dep-t1->t2")).toBeNull());
    // and redo is now available to re-apply it
    await waitFor(() => expect(screen.getByTestId("fe4-redo")).toBeEnabled());
  });
});
