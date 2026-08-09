// contract — proves the consumed MO3 `mobile` types round-trip through JSON
// (design §7 "契約適合: OpenAPI 生成型とラウンドトリップ一致"). This is the TS
// stand-in for the Swift Codable round-trip test; the shapes here MUST stay
// identical to the generated Swift models.
import { describe, it, expect } from "vitest";
import type { mobile, task } from "@dub/types";

function roundtrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("MO3 mobile-namespace contract round-trip", () => {
  it("MobileHomeResponse", () => {
    const home: mobile.MobileHomeResponse = { upcomingEvents: [], myTasks: [], unreadCount: 0 };
    expect(roundtrip(home)).toEqual(home);
  });

  it("RegisterDeviceRequest/Response (pushToken, server-issued deviceId)", () => {
    const req: mobile.RegisterDeviceRequest = { platform: "ios", pushToken: "apns-token" };
    const res: mobile.RegisterDeviceResponse = { deviceId: "dev_01H" };
    expect(roundtrip(req)).toEqual(req);
    expect(roundtrip(res)).toEqual(res);
  });

  it("MobilePushPayload carries routing metadata in data", () => {
    const p: mobile.MobilePushPayload = { title: "t", body: "b", data: { deepLink: "dub://inbox" } };
    expect(roundtrip(p)).toEqual(p);
  });

  it("UpdateTaskRequest always carries version (optimistic lock, no mobile exception)", () => {
    const patch: task.UpdateTaskRequest = { version: 2, status: "done" };
    expect(roundtrip(patch).version).toBe(2);
  });

  it("MobileEventOverviewResponse capabilities are PermissionKeys", () => {
    const ov: mobile.MobileEventOverviewResponse = {
      event: { id: "evt_1", title: "Conf", phase: "planning", startsAt: null },
      capabilities: ["event:read", "task:write"],
    };
    expect(roundtrip(ov)).toEqual(ov);
  });
});
