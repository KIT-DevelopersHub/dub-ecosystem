import { describe, it, expect } from "vitest";
import { event } from "@dub/types";
import {
  allowedPhaseTargets,
  isTransitionAllowed,
  requiredPermissionForTransition,
  canTransition,
  phaseTransitionOptions,
} from "../src/lib/phase";

describe("phase transitions (test observation #7)", () => {
  it("mirrors the frozen EVENT_PHASE_TRANSITIONS table", () => {
    expect(allowedPhaseTargets("planning")).toEqual(event.EVENT_PHASE_TRANSITIONS.planning);
    expect(allowedPhaseTargets("closed")).toEqual([]);
  });

  it("rejects transitions not in the table", () => {
    expect(isTransitionAllowed("planning", "closed")).toBe(false);
    expect(isTransitionAllowed("planning", "preparing")).toBe(true);
  });

  it("forward-adjacent needs event:write", () => {
    expect(requiredPermissionForTransition("planning", "preparing")).toBe("event:write");
    expect(requiredPermissionForTransition("open", "live")).toBe("event:write");
  });

  it("back-transitions need event:admin", () => {
    expect(requiredPermissionForTransition("preparing", "planning")).toBe("event:admin");
    expect(requiredPermissionForTransition("live", "open")).toBe("event:admin");
  });

  it("closed transition needs event:admin", () => {
    expect(requiredPermissionForTransition("wrapup", "closed")).toBe("event:admin");
  });

  it("gates activation by permission", () => {
    // write-only user can go forward but not close, not back
    expect(canTransition("wrapup", "closed", { write: true, admin: false })).toBe(false);
    expect(canTransition("wrapup", "closed", { write: true, admin: true })).toBe(true);
    expect(canTransition("planning", "preparing", { write: true, admin: false })).toBe(true);
    expect(canTransition("preparing", "planning", { write: true, admin: false })).toBe(false);
  });

  it("phaseTransitionOptions marks closed as dangerous and disabled without admin", () => {
    const opts = phaseTransitionOptions("wrapup", { write: true, admin: false });
    const closed = opts.find((o) => o.to === "closed");
    expect(closed?.dangerous).toBe(true);
    expect(closed?.enabled).toBe(false);
  });
});
