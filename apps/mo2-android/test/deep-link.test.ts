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
});
