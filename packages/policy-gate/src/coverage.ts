// Coverage: the mechanism that makes "I forgot the policy entry" a CI failure.
//
// The gate already fails closed at runtime, so a forgotten entry is a 403 rather than a hole.
// That is safe but late — it surfaces as a broken feature in demo. `assertRouteCoverage` is
// the early half: one test per service compares the router's registered endpoints against the
// table's keys and fails on EITHER direction of mismatch.
import type { PolicyTable } from "./table";
import { protectableRouteKeys, type RoutedApp } from "./routes";

export interface CoverageResult {
  ok: boolean;
  /** Registered endpoints with no table entry. The gate 403s these — a forgotten rule. */
  unlisted: string[];
  /**
   * Table entries matching no registered endpoint. Dead weight, and a live hazard: a typo'd
   * key ("GET /driveshare/file") means the REAL route is unlisted while the table looks full.
   */
  orphaned: string[];
}

export function checkRouteCoverage(app: RoutedApp, table: PolicyTable): CoverageResult {
  const registered = protectableRouteKeys(app);
  const listed = Object.keys(table);
  const registeredSet = new Set(registered);
  const listedSet = new Set(listed);
  const unlisted = registered.filter((k) => !listedSet.has(k));
  const orphaned = listed.filter((k) => !registeredSet.has(k));
  return { ok: unlisted.length === 0 && orphaned.length === 0, unlisted, orphaned };
}

/** Throws a message naming exactly what to add or delete. Call from one test per service. */
export function assertRouteCoverage(app: RoutedApp, table: PolicyTable): void {
  const result = checkRouteCoverage(app, table);
  if (result.ok) return;
  const lines: string[] = ["policy table does not match the registered routes."];
  if (result.unlisted.length > 0) {
    lines.push(
      `  ${result.unlisted.length} route(s) have NO rule (the gate denies them) — add to the table:`,
      // The rule forms, in the order to consider them: keys first (the common case), then the
      // internal forms for a service-to-service-only endpoint, AUTHENTICATED only for a
      // self-scoped `/me`-shaped route, PUBLIC only when the open internet really is meant to
      // reach it. See rule.ts for why a probe is INTERNAL and not PUBLIC, and for the
      // "when this is wrong" note on each of the looser forms.
      ...result.unlisted.map(
        (k) =>
          `    "${k}": [/* required PermissionKey(s) */] | internalWithKeys([...]) | INTERNAL | AUTHENTICATED | PUBLIC`,
      ),
    );
  }
  if (result.orphaned.length > 0) {
    lines.push(
      `  ${result.orphaned.length} table entr(ies) match no route (typo or deleted endpoint) — remove:`,
      ...result.orphaned.map((k) => `    "${k}"`),
    );
  }
  throw new Error(lines.join("\n"));
}
