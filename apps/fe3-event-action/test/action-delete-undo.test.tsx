import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, setAuth, resetAuth } from "./util";
import { createMockEventApi } from "../src/api/mockData";
import { ActionBoard } from "../src/components/ActionBoard";
import type { common } from "@dub/types";

beforeEach(() => resetAuth());
afterEach(() => resetAuth());

async function setup() {
  setAuth(["event:read", "event:write"]);
  const api = createMockEventApi({ events: 1, actionsPerEvent: 2 });
  const events = await api.listEvents({});
  const eventId = events.items[0]!.id as common.EventId;
  const archiveSpy = vi.spyOn(api, "archiveAction");
  renderWithProviders(<ActionBoard eventId={eventId} canWrite />, { api });
  await screen.findByText("アクション 1");
  return { api, eventId, archiveSpy };
}

describe("ActionBoard — undoable delete (⑤ 取り消し)", () => {
  it("delete removes the row, shows an undo toast, and undo restores it without committing", async () => {
    const { archiveSpy } = await setup();

    // open the delete confirm on the first action, then confirm
    await userEvent.click(screen.getAllByLabelText("アクションを削除")[0]!);
    await userEvent.click(await screen.findByText("削除する"));

    // row is gone immediately; the undo toast is shown
    await waitFor(() => expect(screen.queryByText("アクション 1")).toBeNull());
    const undo = await screen.findByTestId("toast-action-info");
    expect(undo).toHaveTextContent("元に戻す");

    // undo brings the row back, and the server DELETE is never issued
    await userEvent.click(undo);
    await screen.findByText("アクション 1");
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  // The deferred-commit path (fires the DELETE once after the grace window unless
  // undone) is covered at the hook level in @dub/app-ui's useUndoableAction.test.tsx,
  // which drives the timers deterministically without React Query's async churn.
});
