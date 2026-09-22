// Shared section layout (D&D order/visibility) — component-level coverage for what a
// real-browser E2E can't cheaply assert on every run: permission gating (no edit
// toggle for a read-only viewer) and that a hide/show toggle persists through the
// mock backend (localStorage-backed, mirroring the real event-service's optimistic
// version-locked store). Pointer/keyboard drag itself is covered by the e2e spec
// (real layout engine required; jsdom has none).
import { afterEach, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventDetailsPanel } from "../src/components/EventDetailsPanel";
import { createMockEventApi } from "../src/api/mockData";
import { renderWithProviders, setAuth, resetAuth, newQueryClient } from "./util";

afterEach(() => resetAuth());

test("read-only viewer (no event:write) sees no 並べ替え toggle", async () => {
  setAuth(["event:read"]);
  const api = createMockEventApi({ events: 0, actionsPerEvent: 0 });
  const ev = await api.createEvent({ title: "読み取り専用イベント" });
  renderWithProviders(<EventDetailsPanel eventId={ev.id} canWrite={false} />, {
    api,
    queryClient: newQueryClient(),
  });

  await waitFor(() => expect(screen.getByTestId("fe3-details")).toBeInTheDocument());
  expect(screen.queryByTestId("fe3-layout-edit-toggle")).toBeNull();
  expect(screen.queryByTestId("fe3-details-edit")).toBeNull();
});

test("event:write viewer can toggle 並べ替え, hide a section, and it persists across remount", async () => {
  setAuth(["event:read", "event:write"]);
  const api = createMockEventApi({ events: 0, actionsPerEvent: 0 });
  const ev = await api.createEvent({ title: "レイアウト編集イベント" });
  const eventId = ev.id;

  const first = renderWithProviders(<EventDetailsPanel eventId={eventId} canWrite />, {
    api,
    queryClient: newQueryClient(),
  });

  await waitFor(() => expect(screen.getByTestId("fe3-details")).toBeInTheDocument());
  const toggle = screen.getByTestId("fe3-layout-edit-toggle");
  expect(toggle).toBeInTheDocument();

  // Enter layout 編集モード — the content 編集 button is hidden while it's active.
  await userEvent.click(toggle);
  expect(screen.getByTestId("fe3-details")).toHaveAttribute("data-layout-editing", "true");
  expect(screen.queryByTestId("fe3-details-edit")).toBeNull();
  expect(screen.getByTestId("fe3-section-handle-links")).toBeInTheDocument();

  // Hide "重要リンク" — the mock API persists it (localStorage), same shape as the
  // real event-service's shared, version-locked section-layout row.
  await userEvent.click(screen.getByTestId("fe3-section-hide-links"));
  await waitFor(() => expect(screen.getByTestId("fe3-section-hide-links")).toHaveAttribute("aria-pressed", "false"));

  // Exit edit mode; the hidden section no longer renders in the resting view.
  await userEvent.click(screen.getByTestId("fe3-layout-edit-toggle"));
  await waitFor(() => expect(screen.getByTestId("fe3-details")).not.toHaveAttribute("data-layout-editing"));
  expect(screen.queryByTestId("fe3-details-links")).toBeNull();

  first.unmount();

  // Remount against the SAME api/localStorage — proves the layout is a persisted
  // document, not merely React state (mirrors the server round-trip a page reload
  // would do against event-service).
  renderWithProviders(<EventDetailsPanel eventId={eventId} canWrite />, {
    api,
    queryClient: newQueryClient(),
  });
  await waitFor(() => expect(screen.getByTestId("fe3-details")).toBeInTheDocument());
  expect(screen.queryByTestId("fe3-details-links")).toBeNull();
});
