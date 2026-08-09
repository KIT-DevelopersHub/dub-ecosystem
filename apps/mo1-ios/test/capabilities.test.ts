import { describe, it, expect } from "vitest";
import { can, canEditEvent, canWriteTask } from "../src/capabilities.js";

describe("capabilities-driven UI gating (design §6, default deny)", () => {
  it("shows edit UI only when the capability is granted", () => {
    expect(canEditEvent(["event:read"])).toBe(false);
    expect(canEditEvent(["event:read", "event:write"])).toBe(true);
    expect(canWriteTask(["task:read"])).toBe(false);
    expect(canWriteTask(["task:write"])).toBe(true);
  });

  it("default deny for an empty capability set", () => {
    expect(can([], "task:write")).toBe(false);
  });
});
