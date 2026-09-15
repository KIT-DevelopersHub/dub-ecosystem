// Feature phase state machine — the progress-management core.
//
// This encodes the Dub development flow (`~/.claude/rules/dub-development-flow.md`)
// as code so that two failure modes become structurally impossible:
//   1. 段飛ばし (skipping a phase, e.g. demo -> prod without staging)
//   2. 自己承認 (advancing a phase without explicit user approval)
//
// Pure module: no I/O, no DB. The daemon/UI persist `FeaturePhase` and call
// `transition()` on every move; illegal or unapproved moves throw.

export type FeaturePhase =
  | "demo_building"
  | "demo_review"
  | "demo_rejected"
  | "staging_deployed"
  | "staging_review"
  | "staging_rejected"
  | "prod_shipped";

export interface TransitionSpec {
  to: FeaturePhase;
  /** true => the move MUST carry explicit user approval (no self-approval). */
  requiresApproval: boolean;
  /** Human label for the move, shown in the UI / audit log. */
  label: string;
}

// Allowed edges only. Anything not listed here is 段飛ばし and is rejected.
const TRANSITIONS: Record<FeaturePhase, TransitionSpec[]> = {
  demo_building: [
    { to: "demo_review", requiresApproval: false, label: "demoデプロイ完了→確認待ち" },
  ],
  demo_review: [
    { to: "staging_deployed", requiresApproval: true, label: "demo承認→staging反映" },
    { to: "demo_rejected", requiresApproval: false, label: "demo却下(要修正)" },
  ],
  demo_rejected: [
    { to: "demo_building", requiresApproval: false, label: "修正して再demo" },
  ],
  staging_deployed: [
    { to: "staging_review", requiresApproval: false, label: "staging反映完了→確認待ち" },
  ],
  staging_review: [
    { to: "prod_shipped", requiresApproval: true, label: "staging承認→本番反映" },
    { to: "staging_rejected", requiresApproval: false, label: "staging却下(要修正)" },
  ],
  staging_rejected: [
    { to: "demo_building", requiresApproval: false, label: "修正してdemoに戻す" },
  ],
  prod_shipped: [], // terminal
};

export const INITIAL_PHASE: FeaturePhase = "demo_building";

export function allowedTransitions(from: FeaturePhase): readonly TransitionSpec[] {
  return TRANSITIONS[from];
}

export function findTransition(
  from: FeaturePhase,
  to: FeaturePhase,
): TransitionSpec | undefined {
  return TRANSITIONS[from].find((t) => t.to === to);
}

export function canTransition(from: FeaturePhase, to: FeaturePhase): boolean {
  return findTransition(from, to) !== undefined;
}

export class PhaseTransitionError extends Error {
  readonly code: "illegal_transition" | "approval_required";
  constructor(message: string, code: "illegal_transition" | "approval_required") {
    super(message);
    this.name = "PhaseTransitionError";
    this.code = code;
  }
}

export interface TransitionOptions {
  /** Set true only when the USER explicitly approved this phase advance. */
  approvedByUser?: boolean;
}

/**
 * Advance a feature's phase. Throws on 段飛ばし (illegal edge) or on an
 * approval-required edge attempted without `approvedByUser: true`.
 */
export function transition(
  from: FeaturePhase,
  to: FeaturePhase,
  opts: TransitionOptions = {},
): FeaturePhase {
  const spec = findTransition(from, to);
  if (!spec) {
    throw new PhaseTransitionError(
      `Illegal phase transition: ${from} -> ${to} (段飛ばし禁止)`,
      "illegal_transition",
    );
  }
  if (spec.requiresApproval && opts.approvedByUser !== true) {
    throw new PhaseTransitionError(
      `Transition ${from} -> ${to} requires explicit user approval (自己承認禁止)`,
      "approval_required",
    );
  }
  return to;
}
