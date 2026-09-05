import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import { avatarColor, avatarInitials, presenceLabel } from "../src/realtime/presence";

describe("avatarColor", () => {
  it("is deterministic (same id → same colour)", () => {
    expect(avatarColor("user_a")).toBe(avatarColor("user_a"));
  });
  it("differs across ids (hue driven by id)", () => {
    expect(avatarColor("user_a")).not.toBe(avatarColor("user_b"));
  });
  it("is a fixed-S/L HSL so white text stays legible", () => {
    expect(avatarColor("user_a")).toMatch(/^hsl\(\d+ 58% 42%\)$/);
  });
});

describe("avatarInitials", () => {
  it("takes two word-initials for a Latin full name", () => {
    expect(avatarInitials("Taro Yamada")).toBe("TY");
  });
  it("takes the first two chars for a single Latin word", () => {
    expect(avatarInitials("alice")).toBe("AL");
  });
  it("takes the first grapheme (surname) for a CJK label", () => {
    expect(avatarInitials("山田 太郎")).toBe("山");
  });
  it("falls back to ? for an empty label", () => {
    expect(avatarInitials("")).toBe("?");
    expect(avatarInitials(null)).toBe("?");
  });
});

describe("presenceLabel", () => {
  const roster = new Map([["user_a", "山田 太郎"]]);
  it("prefers the DO-signed displayName", () => {
    const u = { userId: "user_a", displayName: "Signed Name", editing: false, editingTaskIds: [] } as gantt.GanttPresenceUser;
    expect(presenceLabel(u, roster)).toBe("Signed Name");
  });
  it("falls back to the roster when no signed name", () => {
    const u = { userId: "user_a", editing: false, editingTaskIds: [] } as gantt.GanttPresenceUser;
    expect(presenceLabel(u, roster)).toBe("山田 太郎");
  });
  it("falls back to the raw id when unknown everywhere", () => {
    const u = { userId: "user_z", editing: false, editingTaskIds: [] } as gantt.GanttPresenceUser;
    expect(presenceLabel(u, roster)).toBe("user_z");
  });
});
