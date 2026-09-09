// Draft autosave + restore regression for the event edit form (P1-2).
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { event } from "@dub/types";
import { EventEditForm } from "../src/components/EventEditForm";
import { renderWithProviders, setAuth, resetAuth } from "./util";

const ev: event.DubEvent = {
  id: "evt_1",
  orgId: "org_devhub",
  title: "元のタイトル",
  description: null,
  phase: "open",
  startsAt: null,
  endsAt: null,
  archivedAt: null,
  version: 1,
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
};

const KEY = "fe3.event.evt_1";

describe("EventEditForm — draft autosave", () => {
  beforeEach(() => {
    resetAuth();
    setAuth(["event:read", "event:write"]);
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* storage disabled */
    }
  });

  it("auto-saves edits and restores them on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<EventEditForm event={ev} canWrite />);
    const title = screen.getByTestId("fe3-settings-edit-form").querySelector("#fe3-edit-title") as HTMLInputElement;
    await user.clear(title);
    await user.type(title, "書きかけタイトル");
    await waitFor(() => expect(globalThis.localStorage.getItem(KEY)).toContain("書きかけタイトル"));

    unmount();
    renderWithProviders(<EventEditForm event={ev} canWrite />);
    const restored = screen.getByTestId("fe3-settings-edit-form").querySelector("#fe3-edit-title") as HTMLInputElement;
    expect(restored.value).toBe("書きかけタイトル");
    expect(screen.getByTestId("fe3-settings-draft-notice")).toBeInTheDocument();
  });

  it("discards the restored draft and returns to the server value", async () => {
    const user = userEvent.setup();
    globalThis.localStorage.setItem(KEY, JSON.stringify({ title: "破棄されるタイトル", description: "x" }));
    renderWithProviders(<EventEditForm event={ev} canWrite />);
    const title = screen.getByTestId("fe3-settings-edit-form").querySelector("#fe3-edit-title") as HTMLInputElement;
    expect(title.value).toBe("破棄されるタイトル");
    await user.click(screen.getByTestId("fe3-settings-draft-notice-discard"));
    expect((screen.getByTestId("fe3-settings-edit-form").querySelector("#fe3-edit-title") as HTMLInputElement).value).toBe("元のタイトル");
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
  });

  it("does not persist a draft while read-only", async () => {
    renderWithProviders(<EventEditForm event={ev} canWrite={false} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
  });
});
