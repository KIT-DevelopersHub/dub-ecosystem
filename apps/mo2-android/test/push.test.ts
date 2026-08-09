import { describe, it, expect } from "vitest";
import { parsePush } from "../src/push";

describe("parsePush — FCM MobilePushPayload + tap route (§2-3, test #5)", () => {
  it("parses title/body and resolves App Link deepLink to route", () => {
    const p = parsePush({
      title: "New task",
      body: "You were assigned T-1",
      data: {
        notificationId: "ntf_1",
        deepLink: "https://developershub.jp/tasks/tsk_1",
        badge: "3",
      },
    });
    expect(p.payload.title).toBe("New task");
    expect(p.payload.body).toBe("You were assigned T-1");
    expect(p.tapRoute).toEqual({ screen: "taskDetail", taskId: "tsk_1" });
    expect(p.notificationId).toBe("ntf_1");
    expect(p.badge).toBe(3);
  });

  it("resolves dub:// fallback deepLink", () => {
    const p = parsePush({ title: "x", body: "y", data: { deepLink: "dub://inbox" } });
    expect(p.tapRoute).toEqual({ screen: "inbox" });
  });

  it("title/body can come from data map (data-only message)", () => {
    const p = parsePush({ data: { title: "T", body: "B", deepLink: "dub://home" } });
    expect(p.payload.title).toBe("T");
    expect(p.payload.body).toBe("B");
    expect(p.tapRoute).toEqual({ screen: "home" });
  });

  it("missing deepLink -> unknown route, null badge", () => {
    const p = parsePush({ title: "T", body: "B" });
    expect(p.tapRoute.screen).toBe("unknown");
    expect(p.badge).toBeNull();
    expect(p.notificationId).toBeNull();
  });
});
