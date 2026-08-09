import { describe, it, expect } from "vitest";
import { parseDeepLink } from "../src/deep-link";

describe("parseDeepLink — App Links canonical + dub:// fallback (§2-4)", () => {
  it("App Link /home -> home", () => {
    expect(parseDeepLink("https://developershub.jp/home")).toEqual({ screen: "home" });
  });
  it("App Link event detail", () => {
    expect(parseDeepLink("https://developershub.jp/events/evt_123")).toEqual({
      screen: "eventDetail",
      eventId: "evt_123",
    });
  });
  it("App Link task detail", () => {
    expect(parseDeepLink("https://developershub.jp/tasks/tsk_9")).toEqual({
      screen: "taskDetail",
      taskId: "tsk_9",
    });
  });
  it("App Link inbox", () => {
    expect(parseDeepLink("https://developershub.jp/inbox")).toEqual({ screen: "inbox" });
  });

  it("dub:// fallback event detail", () => {
    expect(parseDeepLink("dub://events/evt_123")).toEqual({
      screen: "eventDetail",
      eventId: "evt_123",
    });
  });
  it("dub:// fallback home", () => {
    expect(parseDeepLink("dub://home")).toEqual({ screen: "home" });
  });
  it("dub:// fallback task", () => {
    expect(parseDeepLink("dub://tasks/tsk_1")).toEqual({ screen: "taskDetail", taskId: "tsk_1" });
  });

  it("retired devhub:// scheme -> unknown", () => {
    expect(parseDeepLink("devhub://home")).toEqual({ screen: "unknown", raw: "devhub://home" });
  });
  it("wrong host -> unknown", () => {
    const raw = "https://evil.example.com/tasks/tsk_1";
    expect(parseDeepLink(raw)).toEqual({ screen: "unknown", raw });
  });
  it("event without id -> unknown", () => {
    expect(parseDeepLink("https://developershub.jp/events")).toEqual({
      screen: "unknown",
      raw: "https://developershub.jp/events",
    });
  });
  it("garbage -> unknown", () => {
    expect(parseDeepLink("not a url")).toEqual({ screen: "unknown", raw: "not a url" });
  });

  // ---- S11 gantt ----
  it("App Link /events/{id}/gantt -> eventGantt", () => {
    expect(parseDeepLink("https://developershub.jp/events/evt_1/gantt")).toEqual({
      screen: "eventGantt",
      eventId: "evt_1",
    });
  });
  it("App Link /gantt/{eventId} shorthand -> eventGantt", () => {
    expect(parseDeepLink("https://developershub.jp/gantt/evt_2")).toEqual({
      screen: "eventGantt",
      eventId: "evt_2",
    });
  });
  it("dub://gantt/{eventId} fallback -> eventGantt", () => {
    expect(parseDeepLink("dub://gantt/evt_3")).toEqual({ screen: "eventGantt", eventId: "evt_3" });
  });
  it("gantt without eventId -> unknown", () => {
    expect(parseDeepLink("dub://gantt")).toEqual({ screen: "unknown", raw: "dub://gantt" });
  });
  it("plain /events/{id} still resolves to eventDetail (not gantt)", () => {
    expect(parseDeepLink("https://developershub.jp/events/evt_9")).toEqual({
      screen: "eventDetail",
      eventId: "evt_9",
    });
  });

  // ---- S10 chat ----
  it("App Link /chat -> chat list", () => {
    expect(parseDeepLink("https://developershub.jp/chat")).toEqual({ screen: "chat" });
  });
  it("App Link /chat/channels/{id} -> chatChannel", () => {
    expect(parseDeepLink("https://developershub.jp/chat/channels/chn_1")).toEqual({
      screen: "chatChannel",
      channelId: "chn_1",
    });
  });
  it("dub://chat fallback -> chat list", () => {
    expect(parseDeepLink("dub://chat")).toEqual({ screen: "chat" });
  });
  it("dub://chat/{id} shorthand -> chatChannel", () => {
    expect(parseDeepLink("dub://chat/chn_2")).toEqual({ screen: "chatChannel", channelId: "chn_2" });
  });
  it("chat channels without id -> unknown", () => {
    const raw = "https://developershub.jp/chat/channels";
    expect(parseDeepLink(raw)).toEqual({ screen: "unknown", raw });
  });
});
