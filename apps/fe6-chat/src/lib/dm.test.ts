import { describe, it, expect } from "vitest";
import type { Channel } from "../api/contract";
import { channelLabel, dmPeerIds } from "./dm";

const base: Channel = {
  id: "chn_1",
  orgId: "org",
  type: "dm",
  visibility: "private",
  name: "DM",
  topic: null,
  eventId: null,
  archived: false,
  memberCount: 2,
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const names: Record<string, string> = { me: "自分", a: "佐藤 花子", b: "山本 健一" };
const resolve = (id: string) => (names[id] ? { id, displayName: names[id]!, avatarUrl: null } : undefined);

describe("dm labels", () => {
  it("labels a 1:1 DM by the other person, from either side", () => {
    const c = { ...base, memberIds: ["me", "a"] };
    expect(channelLabel(c, "me", resolve)).toBe("佐藤 花子");
    expect(channelLabel(c, "a", resolve)).toBe("自分");
  });

  it("joins group DM peers and excludes me", () => {
    const c = { ...base, memberIds: ["me", "a", "b"] };
    expect(dmPeerIds(c, "me")).toEqual(["a", "b"]);
    expect(channelLabel(c, "me", resolve)).toBe("佐藤 花子、山本 健一");
  });

  it("returns null while a peer is unresolved, and keeps non-DM names", () => {
    expect(channelLabel({ ...base, memberIds: ["me", "x"] }, "me", resolve)).toBeNull();
    expect(channelLabel({ ...base, type: "topic", name: "general" }, "me", resolve)).toBe("general");
    expect(channelLabel(base, "me", resolve)).toBe("DM"); // no memberIds -> stored name
  });
});
