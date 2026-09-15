import { describe, it, expect } from "vitest";
import {
  INITIAL_PHASE,
  canTransition,
  transition,
  allowedTransitions,
  PhaseTransitionError,
  type FeaturePhase,
} from "../src/phases.ts";

describe("feature phase state machine", () => {
  it("starts at demo_building", () => {
    expect(INITIAL_PHASE).toBe<FeaturePhase>("demo_building");
  });

  it("allows the happy path demo -> staging -> prod with approvals", () => {
    let p: FeaturePhase = INITIAL_PHASE;
    p = transition(p, "demo_review"); // deploy done, no approval
    p = transition(p, "staging_deployed", { approvedByUser: true }); // demo OK
    p = transition(p, "staging_review");
    p = transition(p, "prod_shipped", { approvedByUser: true }); // staging OK
    expect(p).toBe("prod_shipped");
  });

  it("rejects 段飛ばし (skipping a phase)", () => {
    expect(canTransition("demo_building", "staging_deployed")).toBe(false);
    expect(canTransition("demo_review", "prod_shipped")).toBe(false);
    expect(() => transition("demo_review", "prod_shipped")).toThrowError(
      PhaseTransitionError,
    );
    try {
      transition("demo_building", "prod_shipped");
      expect.unreachable();
    } catch (e) {
      expect((e as PhaseTransitionError).code).toBe("illegal_transition");
    }
  });

  it("blocks 自己承認: approval-required moves fail without approvedByUser", () => {
    expect(() => transition("demo_review", "staging_deployed")).toThrowError(
      /approval/i,
    );
    try {
      transition("staging_review", "prod_shipped", { approvedByUser: false });
      expect.unreachable();
    } catch (e) {
      expect((e as PhaseTransitionError).code).toBe("approval_required");
    }
    // approved => allowed
    expect(transition("staging_review", "prod_shipped", { approvedByUser: true })).toBe(
      "prod_shipped",
    );
  });

  it("routes rejections back to rework without approval", () => {
    expect(transition("demo_review", "demo_rejected")).toBe("demo_rejected");
    expect(transition("demo_rejected", "demo_building")).toBe("demo_building");
    expect(transition("staging_review", "staging_rejected")).toBe("staging_rejected");
    expect(transition("staging_rejected", "demo_building")).toBe("demo_building");
  });

  it("prod_shipped is terminal", () => {
    expect(allowedTransitions("prod_shipped")).toHaveLength(0);
  });
});
