// #879 event hub overview.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, setAuth, resetAuth } from "./util";
import { createMockEventApi } from "../src/api/mockData";
import { EventHubOverview } from "../src/components/EventHubOverview";
import { daysUntil, eventAppLinks } from "../src/lib/eventLinks";
import type { event } from "@dub/types";

beforeEach(() => resetAuth());
afterEach(() => resetAuth());

describe("eventAppLinks", () => {
  it("scopes gantt / tasks / chat to the event and opens calendar / mail / members as a whole", () => {
    const links = Object.fromEntries(eventAppLinks("evt_1").map((l) => [l.id, l]));
    expect(links.gantt).toMatchObject({ href: "/events/evt_1/tasks/gantt", scoped: true });
    expect(links.tasks).toMatchObject({ href: "/events/evt_1/tasks", scoped: true });
    expect(links.chat).toMatchObject({ href: "/chat?eventId=evt_1", scoped: true });
    expect(links.calendar).toMatchObject({ href: "/calendar", scoped: false });
    expect(links.mail).toMatchObject({ href: "/mail", scoped: false });
    expect(links.members).toMatchObject({ href: "/members", scoped: false });
  });
});

describe("daysUntil", () => {
  const now = new Date("2026-08-01T00:00:00Z");
  it("counts whole days ahead, goes negative once past, null when unknown", () => {
    expect(daysUntil("2026-08-05T00:00:00Z", now)).toBe(4);
    expect(daysUntil("2026-07-30T00:00:00Z", now)).toBeLessThan(0);
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil("not a date", now)).toBeNull();
  });
});

describe("EventHubOverview", () => {
  async function setup(canWrite = false) {
    setAuth(["event:read"]);
    const api = createMockEventApi({ events: 1, actionsPerEvent: 2 });
    const page = await api.listEvents({});
    const ev = (await api.getEvent(page.items[0]!.id)) as event.DubEvent;
    const r = renderWithProviders(
      <EventHubOverview event={ev} canWrite={canWrite} pageEditing={false} onEditInfo={() => {}} onTogglePageEdit={() => {}} />,
      { api },
    );
    return { ...r, ev };
  }

  it("shows the fixed facts, the app links and the event's actions (イベント > アクション)", async () => {
    const { ev, navigate } = await setup();
    expect(screen.getByTestId("fe3-overview-fact-date")).toBeTruthy();
    expect(screen.getByTestId("fe3-overview-fact-venue")).toBeTruthy();

    await userEvent.click(screen.getByTestId("fe3-overview-app-gantt"));
    expect(navigate).toHaveBeenCalledWith(`/events/${ev.id}/tasks/gantt`);

    const rows = await screen.findAllByTestId(/^fe3-overview-action-/);
    expect(rows.length).toBe(2);
    await userEvent.click(rows[0]!);
    expect(navigate).toHaveBeenLastCalledWith(expect.stringMatching(new RegExp(`^/events/${ev.id}/actions/`)));
  });

  it("hides edit buttons for read-only users but keeps settings", async () => {
    const { ev, navigate } = await setup(false);
    expect(screen.queryByTestId("fe3-hub-edit-event")).toBeNull();
    await userEvent.click(screen.getByTestId("fe3-hub-open-settings"));
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining(`/events/${ev.id}/settings`));
  });

  it("labels calendar / mail / members as 全体", async () => {
    await setup();
    expect(screen.getByTestId("fe3-overview-app-calendar").textContent).toContain("全体");
    expect(screen.getByTestId("fe3-overview-app-gantt").textContent).toContain("このイベント");
  });
});
