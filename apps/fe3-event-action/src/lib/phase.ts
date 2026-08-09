// Phase-transition logic. Single source of truth = @dub/types event
// EVENT_PHASE_TRANSITIONS (same constant the server validates against). Permission
// gating follows the constant's contract note: forward-adjacent = event:write;
// back-transitions and wrapup->closed = event:admin; no transition out of closed.
import { event } from "@dub/types";
import type { identity } from "@dub/types";

export type EventPhase = event.EventPhase;

// Canonical ordering used to distinguish forward vs back transitions.
export const PHASE_ORDER: readonly EventPhase[] = [
  "planning",
  "preparing",
  "open",
  "live",
  "wrapup",
  "closed",
];

export function phaseIndex(phase: EventPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

/** Adjacency from the frozen transition table (both directions allowed there). */
export function allowedPhaseTargets(from: EventPhase): readonly EventPhase[] {
  return event.EVENT_PHASE_TRANSITIONS[from];
}

/** true if `to` is reachable from `from` per the frozen table (permission aside). */
export function isTransitionAllowed(from: EventPhase, to: EventPhase): boolean {
  return allowedPhaseTargets(from).includes(to);
}

export type PhasePermission = Extract<identity.PermissionKey, "event:write" | "event:admin">;

/** Which permission a given transition needs (closed target & back = admin). */
export function requiredPermissionForTransition(from: EventPhase, to: EventPhase): PhasePermission {
  if (to === "closed") return "event:admin";
  if (phaseIndex(to) < phaseIndex(from)) return "event:admin"; // back-transition
  return "event:write";
}

/** UI activation: allowed by table AND the current user holds the needed permission. */
export function canTransition(
  from: EventPhase,
  to: EventPhase,
  perms: { write: boolean; admin: boolean },
): boolean {
  if (!isTransitionAllowed(from, to)) return false;
  const need = requiredPermissionForTransition(from, to);
  return need === "event:admin" ? perms.admin : perms.write;
}

export interface PhaseTransitionOption {
  to: EventPhase;
  enabled: boolean;
  requires: PhasePermission;
  dangerous: boolean; // closed transition -> ConfirmDialog required
}

/** All table-allowed targets for the control, annotated with enablement. */
export function phaseTransitionOptions(
  from: EventPhase,
  perms: { write: boolean; admin: boolean },
): PhaseTransitionOption[] {
  return allowedPhaseTargets(from).map((to) => ({
    to,
    enabled: canTransition(from, to, perms),
    requires: requiredPermissionForTransition(from, to),
    dangerous: to === "closed",
  }));
}
