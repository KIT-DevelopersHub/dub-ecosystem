import { describe, it, expect } from "vitest";
import type { NavEntry } from "../../modules/types.tsx";
import { eventIdFromPathname, resolveAiPanelTarget } from "./aiPanelContext.ts";
import { pickAiPanelSender } from "./aiChatSender.ts";
import type { EventApi } from "@dub/fe3-event-action";

const NAV: NavEntry[] = [
  { label: "イベント", path: "/events", icon: "calendar", order: 10 },
  { label: "メール", path: "/mail", icon: "inbox", order: 20 },
];

describe("aiPanelContext", () => {
  it("reads the event id from /events/<id>… but not from /events or /events/list", () => {
    expect(eventIdFromPathname("/events/evt_1")).toBe("evt_1");
    expect(eventIdFromPathname("/events/evt_1/tasks/gantt")).toBe("evt_1");
    expect(eventIdFromPathname("/events")).toBeNull();
    expect(eventIdFromPathname("/events/list")).toBeNull();
  });

  it("the URL event wins; the events hub and home use the selected event; other apps show the app", () => {
    expect(resolveAiPanelTarget("/events/evt_1", NAV, "evt_2")).toEqual({ kind: "event", eventId: "evt_1" });
    expect(resolveAiPanelTarget("/events", NAV, "evt_2")).toEqual({ kind: "event", eventId: "evt_2" });
    expect(resolveAiPanelTarget("/", NAV, "evt_2")).toEqual({ kind: "event", eventId: "evt_2" });
    expect(resolveAiPanelTarget("/", NAV, null)).toEqual({ kind: "home" });
    expect(resolveAiPanelTarget("/mail/inbox", NAV, "evt_2")).toEqual({ kind: "app", label: "メール" });
    expect(resolveAiPanelTarget("/unknown", NAV, null)).toEqual({ kind: "home" });
  });
});

describe("aiChatSender", () => {
  const eventApi = { askEvent: () => Promise.resolve({ status: "answered", answer: "a", sources: [] }) } as unknown as EventApi;
  it("sends nothing while the AI chat is closed", () => {
    expect(pickAiPanelSender({ kind: "event", eventId: "evt_1" }, eventApi)).toBeUndefined();
  });
  it("once available, an event context is wired to the event question API", async () => {
    const send = pickAiPanelSender({ kind: "event", eventId: "evt_1" }, eventApi, true);
    expect(send).toBeDefined();
    await expect(send!("会場は？")).resolves.toMatchObject({ status: "answered" });
    expect(pickAiPanelSender({ kind: "home" }, eventApi, true)).toBeUndefined();
  });
});
