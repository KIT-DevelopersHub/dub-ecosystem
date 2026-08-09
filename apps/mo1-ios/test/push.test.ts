import { describe, it, expect } from "vitest";
import type { mobile } from "@dub/types";
import { parsePush } from "../src/push.js";

describe("push payload parsing (design §2-2 PushKit, test §7 Push)", () => {
  it("resolves deepLink + badge + metadata from data", () => {
    const payload: mobile.MobilePushPayload = {
      title: "New task",
      body: "You were assigned a task",
      data: {
        deepLink: "https://m.developershub.jp/tasks/task_5",
        badge: "3",
        notificationId: "ntf_1",
        type: "task.assigned",
        correlationId: "req_1",
      },
    };
    const parsed = parsePush(payload);
    expect(parsed.route).toEqual({ name: "task", params: { taskId: "task_5" } });
    expect(parsed.badge).toBe(3);
    expect(parsed.notificationId).toBe("ntf_1");
    expect(parsed.type).toBe("task.assigned");
    expect(parsed.correlationId).toBe("req_1");
  });

  it("defaults to home route and null badge when data is absent", () => {
    const parsed = parsePush({ title: "Hi", body: "there" });
    expect(parsed.route.name).toBe("home");
    expect(parsed.badge).toBeNull();
    expect(parsed.notificationId).toBeNull();
  });

  it("never throws on a non-numeric badge", () => {
    const parsed = parsePush({ title: "t", body: "b", data: { badge: "NaN" } });
    expect(parsed.badge).toBeNull();
  });
});
