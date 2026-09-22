// EventPageLayout — the D1-backed event-page block layout wrapper. Exercises the
// real save/load round-trip through the mock EventApi (which enforces the same
// version-lock contract as the event-service): opening the editor, adding a block,
// the debounced autosave landing in the store, and a fresh mount reading it back
// (the "reload still shows the layout" guarantee, at the unit level).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders, setAuth, resetAuth, newQueryClient } from "./util";
import { createMockEventApi } from "../src/api/mockData";
import { EventPageLayout } from "../src/components/EventPageLayout";
import type { EventApi } from "../src/api/eventApi";

beforeEach(() => {
  resetAuth();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  cleanup();
  resetAuth();
});

async function firstEventId(api: EventApi): Promise<string> {
  const res = await api.listEvents({});
  return res.items[0]!.id;
}

describe("EventPageLayout (D1-backed event-page block layout)", () => {
  it("edit mode adds a block and autosaves it to the backend store", async () => {
    setAuth(["event:read", "event:write"]);
    const api = createMockEventApi({ events: 1, actionsPerEvent: 0 });
    const eventId = await firstEventId(api);

    renderWithProviders(<EventPageLayout eventId={eventId} mode="edit" canWrite />, { api });

    // Editor (not skeleton) is up once the initial GET settles.
    await screen.findByTestId("fe3-blockeditor-palette");

    // Add a text block from the palette.
    fireEvent.click(screen.getByText("テキスト"));
    expect(await screen.findByTestId("fe3-blockeditor-canvas")).toBeTruthy();

    // The debounced autosave lands in the backing store (version 0 -> 1, one block).
    await waitFor(
      async () => {
        const saved = await api.getEventPageLayout(eventId);
        expect(saved.version).toBeGreaterThanOrEqual(1);
        expect(saved.data.blocks.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 4000 },
    );
  });

  it("a fresh mount reads the saved layout back (reload persistence)", async () => {
    setAuth(["event:read", "event:write"]);
    const api = createMockEventApi({ events: 1, actionsPerEvent: 0 });
    const eventId = await firstEventId(api);

    // Seed the store directly through the API (as a prior edit would have).
    await api.saveEventPageLayout(eventId, {
      version: 0,
      data: {
        version: 1,
        updatedAt: new Date().toISOString(),
        blocks: [{ id: "b1", type: "text", span: 4, content: { text: "永続テキスト" } }],
      },
    });

    // A brand-new query client (simulating a reload / another viewer) still shows it.
    renderWithProviders(<EventPageLayout eventId={eventId} mode="view" canWrite={false} />, {
      api,
      queryClient: newQueryClient(),
    });

    expect(await screen.findByText("永続テキスト")).toBeTruthy();
  });

  it("view mode renders nothing when no layout has been saved", async () => {
    setAuth(["event:read"]);
    const api = createMockEventApi({ events: 1, actionsPerEvent: 0 });
    const eventId = await firstEventId(api);

    const { container } = renderWithProviders(
      <EventPageLayout eventId={eventId} mode="view" canWrite={false} />,
      { api },
    );

    // Give the GET a tick to settle; the wrapper self-hides (no block canvas).
    await waitFor(() => expect(screen.queryByTestId("fe3-blockeditor")).toBeNull());
    expect(container.querySelector('[data-testid="fe3-blockeditor-canvas"]')).toBeNull();
  });
});
