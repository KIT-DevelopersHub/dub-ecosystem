# ADR-0006: Cross-scope task dependencies bounded by team

- Status: Accepted
- Date: 2026-08-20
- Deciders: DevHub (Dub) core
- Related: task-service (`services/task-service`), fe4-task-gantt (`apps/fe4-task-gantt`),
  supersedes the「同一直接親のみ依存可」rule (判断10); complements the「送る・受け取る」
  cross-team request flow (design #377). PR #381 (same-team backend門番) is folded in here.

## Context

The task WBS lets a work-package (親タスク) contain children (子タスク), nested to any
depth. A dependency (先行/後続, an FS arrow) expresses "B cannot start until A finishes".

The previous rule (判断10) restricted a dependency to two tasks that share the **same
direct parent** — siblings inside one scope. In practice this was too tight: real plans
need "the 本部 top-level work-package must finish before a 本部 leaf three levels down in
another branch starts". Under the sibling-only rule that edge was un-drawable, so planners
either flattened their WBS or dropped the dependency.

At the same time, dependencies must **not** cross team boundaries. Cross-team coupling is
handled by the separate 送る・受け取る request → approval flow (a task only materialises
for the receiving team once accepted); letting one team wire an arrow straight into another
team's schedule would bypass that hand-off and make one team's slip silently reschedule
another's critical path.

## Decision

**A dependency may connect any two tasks that belong to the same team, regardless of their
WBS scope / hierarchy level. The team is the only boundary; cross-team dependencies are
rejected.**

- `teamId === null` is its own "no team" bucket: two team-less tasks may depend
  (back-compat with data created before teams); a one-sided null is a team mismatch.
- Enforced in three places, all deriving the boundary from the same rule:
  1. **Backend門番** — `PUT /tasks/:id/dependencies` in `services/task-service/src/app.ts`
     compares `task_tasks.team_id` of the current task and each `dependsOn` target; a
     mismatch returns `400 VALIDATION_FAILED` with reason
     `task.DEPENDENCY_REJECT_REASONS.crossTeamNotAllowed` (`cross_team_not_allowed`).
     Task-level team is now persisted (migration `task/0004_task_team_id.sql`).
  2. **Frontend picker** — `apps/fe4-task-gantt/src/domain/task-hierarchy.ts`
     (`dependencyScopeOptions` / `pruneToScope`) offers same-team tasks across all scopes
     and excludes other teams, so the UI never proposes an edge the server would reject.
  3. **Mock client** — the fe4 `MockApiClient` mirrors the same-team gate so the demo /
     tests behave like production.
- **Arrow rendering (visual):** an arrow whose endpoint is a task hidden inside a collapsed
  parent is re-anchored to the **middle of that parent's bar** (an arrowhead into the
  middle of a 2nd-level bar reads as "a dependency to a child under it"), keeping the edge
  legible while the child is folded. This is a **visual anchor only** — the critical-path
  (CPM) computation stays over the real child tasks and is never derived from the drawn
  coordinates.

## Alternatives Considered

- **Keep sibling-only (判断10).** Rejected: too restrictive for real multi-level plans;
  forced WBS flattening.
- **Allow fully unrestricted (any task ↔ any task).** Rejected: erases the team boundary
  that the 送る・受け取る hand-off depends on; makes cross-team schedule coupling implicit.
- **Scope by shared ancestor (same subtree) instead of team.** Rejected: ancestry is a
  presentation concern that changes on re-parenting; team is the stable ownership boundary
  and matches how work is actually handed off.

## Consequences

- Planners can express dependencies across WBS levels within a team without flattening.
- The team boundary is now explicit and enforced identically on client and server (single
  reason constant in `@dub/types`, no duplicated string).
- `task_tasks` carries `team_id` (additive, nullable) and task create/update persist it;
  pre-existing rows keep `null` and stay valid.
- Re-parenting a task no longer prunes its dependencies (scope is team, not parent).
- Existing dependencies are unaffected; the change is additive at the type/API level
  (success shapes unchanged, only a new failure reason).
