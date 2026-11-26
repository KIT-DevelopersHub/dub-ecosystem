// イベント設定 > 使うアプリ: a switch per event-scoped app (org-wide apps are not listed), legacy events show everything on,
// a toggle saves the FULL set optimistically (rolled back on failure), イベント is locked
// on, and a viewer cannot flip anything.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { event as evNs } from "@dub/types";
import { DubError } from "@dub/errors";
import { EventAppsSettings } from "../src/components/EventAppsSettings";
import { createMockEventApi } from "../src/api/mockData";
import { renderWithProviders } from "./util";

const sw = (id: string) => screen.getByTestId(`fe3-event-apps-${id}`) as HTMLInputElement;

describe("EventAppsSettings", () => {
  it("a legacy (never configured) event shows every app on", async () => {
    const api = createMockEventApi({ events: 1 });
    const { items } = await api.listEvents({});
    renderWithProviders(<EventAppsSettings eventId={items[0]!.id} canWrite />, { api });
    await waitFor(() => expect(screen.getByTestId("fe3-event-apps")).toBeTruthy());
    for (const id of evNs.EVENT_TOGGLEABLE_APPS) expect(sw(id).checked).toBe(true);
    expect(sw("events").disabled).toBe(true); // always on
    // org-wide apps are always on and not a per-event switch
    for (const id of ["mail", "chat", "notifications", "calendar"]) expect(screen.queryByTestId(`fe3-event-apps-${id}`)).toBeNull();
  });

  it("a new event starts with イベント・ガント・ロール管理; turning 運営メンバー on saves the full set", async () => {
    const api = createMockEventApi({ events: 0 });
    const created = await api.createEvent({ title: "miniconference" });
    // Hold the save open so the switch can only be on through the optimistic update.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = api.saveEventApps.bind(api);
    const save = vi.spyOn(api, "saveEventApps").mockImplementation(async (id, req) => {
      await gate;
      return real(id, req);
    });
    renderWithProviders(<EventAppsSettings eventId={created.id} canWrite />, { api });
    await waitFor(() => expect(sw("gantt").checked).toBe(true));
    expect(sw("members").checked).toBe(false);

    fireEvent.click(sw("members"));
    await waitFor(() => expect(sw("members").checked).toBe(true)); // optimistic, save still pending
    release();
    await waitFor(() => expect(save).toHaveBeenCalledWith(created.id, { enabledApps: ["events", "gantt", "members", "admin"] }));
    const saved = (await api.getEventApps(created.id)).enabledApps;
    expect(saved.filter((a) => evNs.isEventToggleableApp(a))).toEqual(["events", "gantt", "members", "admin"]);
    expect(saved).toContain("mail"); // org-wide: always on
  });

  it("rolls the switch back when the save fails", async () => {
    const api = createMockEventApi({ events: 0 });
    const created = await api.createEvent({ title: "x" });
    vi.spyOn(api, "saveEventApps").mockRejectedValue(new DubError("FORBIDDEN", "permission denied", { status: 403 }));
    renderWithProviders(<EventAppsSettings eventId={created.id} canWrite />, { api });
    await waitFor(() => expect(sw("gantt").checked).toBe(true));
    fireEvent.click(sw("gantt"));
    await waitFor(() => expect(sw("gantt").checked).toBe(true));
  });

  it("a viewer sees the switches but cannot flip them", async () => {
    const api = createMockEventApi({ events: 0 });
    const created = await api.createEvent({ title: "x" });
    renderWithProviders(<EventAppsSettings eventId={created.id} canWrite={false} />, { api });
    await waitFor(() => expect(sw("gantt").checked).toBe(true));
    for (const id of evNs.EVENT_TOGGLEABLE_APPS) expect(sw(id).disabled).toBe(true);
  });
});
