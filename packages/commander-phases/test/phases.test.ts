import { describe, it, expect } from "vitest";
import {
  INITIAL_PHASE,
  PHASES,
  isFeaturePhase,
  isTerminal,
  canTransition,
  transition,
  allowedTransitions,
  findTransition,
  PhaseTransitionError,
  type FeaturePhase,
} from "../src/index.ts";

describe("commander feature phase state machine", () => {
  it("starts at demo_building", () => {
    expect(INITIAL_PHASE).toBe<FeaturePhase>("demo_building");
  });

  it("recognises valid phases only", () => {
    expect(PHASES).toHaveLength(7);
    expect(isFeaturePhase("demo_review")).toBe(true);
    expect(isFeaturePhase("nope")).toBe(false);
    expect(isFeaturePhase(42)).toBe(false);
  });

  it("prod_shipped is terminal; others are not", () => {
    expect(isTerminal("prod_shipped")).toBe(true);
    for (const p of PHASES.filter((p) => p !== "prod_shipped")) {
      expect(isTerminal(p)).toBe(false);
    }
  });

  it("allows the happy-path edges", () => {
    expect(canTransition("demo_building", "demo_review")).toBe(true);
    expect(canTransition("demo_review", "staging_deployed")).toBe(true);
    expect(canTransition("staging_deployed", "staging_review")).toBe(true);
    expect(canTransition("staging_review", "prod_shipped")).toBe(true);
  });

  it("rejects 段飛ばし (demo_review -> prod_shipped)", () => {
    expect(canTransition("demo_review", "prod_shipped")).toBe(false);
    try {
      transition("demo_review", "prod_shipped", { approvedByUser: true });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PhaseTransitionError);
      expect((e as PhaseTransitionError).code).toBe("illegal_transition");
      expect((e as PhaseTransitionError).httpStatus).toBe(409);
    }
  });

  it("rejects 自己承認 (approval-required edge without approvedByUser)", () => {
    try {
      transition("demo_review", "staging_deployed");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PhaseTransitionError);
      expect((e as PhaseTransitionError).code).toBe("approval_required");
      expect((e as PhaseTransitionError).httpStatus).toBe(403);
    }
  });

  it("permits an approval-required edge WITH explicit approval", () => {
    expect(transition("demo_review", "staging_deployed", { approvedByUser: true })).toBe(
      "staging_deployed",
    );
    expect(transition("staging_review", "prod_shipped", { approvedByUser: true })).toBe(
      "prod_shipped",
    );
  });

  it("does NOT require approval for system/rejection edges", () => {
    expect(transition("demo_building", "demo_review")).toBe("demo_review");
    expect(transition("demo_review", "demo_rejected")).toBe("demo_rejected");
    expect(transition("demo_rejected", "demo_building")).toBe("demo_building");
    expect(transition("staging_review", "staging_rejected")).toBe("staging_rejected");
  });

  it("labels approval-required edges", () => {
    expect(findTransition("demo_review", "staging_deployed")?.requiresApproval).toBe(true);
    expect(allowedTransitions("demo_review").map((t) => t.to)).toEqual([
      "staging_deployed",
      "demo_rejected",
    ]);
  });
});
