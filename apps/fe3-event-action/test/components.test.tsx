import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, setAuth, resetAuth, makeNav } from "./util";
import { createMockEventApi } from "../src/api/mockData";
import { EventListPage } from "../src/pages/EventListPage";
import { PhaseTransitionControl } from "../src/components/PhaseTransitionControl";
import { GenericActionPanel } from "../src/components/GenericActionPanel";
import type { event } from "@dub/types";

beforeEach(() => resetAuth());
afterEach(() => resetAuth());

describe("EventListPage (test observations #1, #2, #8, #9)", () => {
  it("read-only user sees no create button (#8)", async () => {
    setAuth(["event:read"]);
    renderWithProviders(<EventListPage />);
    await screen.findByText("北陸ITカンファレンス 2026");
    expect(screen.queryByTestId("fe3-eventlist-create")).toBeNull();
  });

  it("write user sees create button and create navigates to detail (#1)", async () => {
    setAuth(["event:read", "event:write"]);
    const api = createMockEventApi({ events: 1, actionsPerEvent: 0 });
    const nav = makeNav();
    renderWithProviders(<EventListPage />, { api, nav });

    const createBtn = await screen.findByTestId("fe3-eventlist-create");
    await userEvent.click(createBtn);
    await userEvent.type(screen.getByTestId("fe3-eventlist-create-title"), "テストイベント");
    await userEvent.click(screen.getByTestId("fe3-eventlist-create-submit"));

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/events\/evt_/)));
  });

  it("phase filter is reflected via setSearch (#9)", async () => {
    setAuth(["event:read"]);
    const nav = makeNav();
    renderWithProviders(<EventListPage />, { nav });
    await screen.findByTestId("fe3-eventlist-phase-filter");
    fireEvent.change(screen.getByTestId("fe3-eventlist-phase-filter"), { target: { value: "open" } });
    expect(nav.setSearch).toHaveBeenCalledWith("phase=open");
  });
});

describe("PhaseTransitionControl (test observations #7, #8)", () => {
  const baseEvent: event.DubEvent = {
    id: "evt_1",
    orgId: "org_devhub",
    title: "E",
    description: null,
    phase: "wrapup",
    startsAt: null,
    endsAt: null,
    archivedAt: null,
    version: 1,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
  };

  it("closed transition is disabled for write-only users (#7/#8)", async () => {
    setAuth(["event:read", "event:write"]);
    renderWithProviders(<PhaseTransitionControl event={baseEvent} permissions={{ write: true, admin: false }} />);
    const closedBtn = await screen.findByTestId("fe3-detail-phase-closed");
    expect(closedBtn).toBeDisabled();
  });

  it("closed transition is enabled for admins", async () => {
    setAuth(["event:read", "event:write", "event:admin"]);
    renderWithProviders(<PhaseTransitionControl event={baseEvent} permissions={{ write: true, admin: true }} />);
    const closedBtn = await screen.findByTestId("fe3-detail-phase-closed");
    expect(closedBtn).not.toBeDisabled();
  });
});

describe("GenericActionPanel (test observation #3)", () => {
  it("renders an unknown kind without breaking", () => {
    const action = {
      id: "act_1",
      eventId: "evt_1",
      kind: "weird_custom_kind",
      title: "変わったアクション",
      sortOrder: 1024,
      archivedAt: null,
      version: 1,
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:00Z",
    } satisfies event.DubAction;
    const ev = { ...action, phase: "open" } as unknown as event.DubEvent;
    renderWithProviders(
      <GenericActionPanel event={ev} action={action} canWrite={false} onPayloadChange={async () => {}} />,
    );
    expect(screen.getByTestId("fe3-action-generic-panel")).toBeInTheDocument();
    expect(screen.getByText("weird_custom_kind")).toBeInTheDocument();
  });
});
