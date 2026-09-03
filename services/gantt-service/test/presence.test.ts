import { describe, it, expect } from "vitest";
import { buildPresenceSnapshot, type SocketMeta } from "../src/presence";

const meta = (userId: string, over: Partial<SocketMeta> = {}): SocketMeta => ({
  userId,
  eventId: "event_1",
  connectedAt: 0,
  ...over,
});

describe("buildPresenceSnapshot", () => {
  it("dedupes a user across multiple tabs into one entry", () => {
    const snap = buildPresenceSnapshot([meta("user_a"), meta("user_a"), meta("user_b")]);
    expect(snap.map((u) => u.userId)).toEqual(["user_a", "user_b"]);
  });

  it("keeps the first-seen displayName for a user", () => {
    const snap = buildPresenceSnapshot([
      meta("user_a", { displayName: "Ada" }),
      meta("user_a", { displayName: "IGNORED" }),
    ]);
    expect(snap).toEqual([{ userId: "user_a", displayName: "Ada" }]);
  });

  it("omits displayName when no tab carried one", () => {
    const snap = buildPresenceSnapshot([meta("user_a")]);
    expect(snap).toEqual([{ userId: "user_a" }]);
  });

  it("orders stably by displayName then userId (locale-aware)", () => {
    const snap = buildPresenceSnapshot([
      meta("user_z", { displayName: "Zoe" }),
      meta("user_a", { displayName: "Ada" }),
      meta("user_m"), // no name → sorts by id "user_m"
    ]);
    expect(snap.map((u) => u.displayName ?? u.userId)).toEqual(["Ada", "user_m", "Zoe"]);
  });

  it("returns an empty snapshot for an empty room", () => {
    expect(buildPresenceSnapshot([])).toEqual([]);
  });
});
