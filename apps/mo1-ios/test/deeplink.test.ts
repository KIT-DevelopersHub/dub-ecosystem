import { describe, it, expect } from "vitest";
import { parseDeepLink } from "../src/deeplink.js";

describe("deeplink parsing (design §2-3 Universal Links + dub:// fallback)", () => {
  it("parses https Universal Links", () => {
    expect(parseDeepLink("https://m.developershub.jp/events/evt_9")).toEqual({
      name: "event",
      params: { eventId: "evt_9" },
    });
    expect(parseDeepLink("https://m.developershub.jp/tasks/task_2")).toEqual({
      name: "task",
      params: { taskId: "task_2" },
    });
    expect(parseDeepLink("https://m.developershub.jp/inbox")).toEqual({ name: "inbox", params: {} });
  });

  it("parses dub:// fallback links", () => {
    expect(parseDeepLink("dub://events/evt_1")).toEqual({ name: "event", params: { eventId: "evt_1" } });
    expect(parseDeepLink("dub://actions/act_1")).toEqual({ name: "action", params: { actionId: "act_1" } });
    expect(parseDeepLink("dub://chat/ch_1")).toEqual({ name: "chat", params: { channelId: "ch_1" } });
  });

  it("falls back to home for unknown, foreign, retired, or malformed links", () => {
    expect(parseDeepLink("https://evil.example.com/tasks/x").name).toBe("home");
    expect(parseDeepLink("devhub://events/evt_1").name).toBe("home"); // retired scheme
    expect(parseDeepLink("https://m.developershub.jp/nonsense").name).toBe("home");
    expect(parseDeepLink("not a url").name).toBe("home");
  });

  it("routes bare host/path to home", () => {
    expect(parseDeepLink("https://m.developershub.jp/").name).toBe("home");
  });
});
