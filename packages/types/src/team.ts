// team — canonical Team entity shared across apps (gantt, member management, …).
// A "team" is a grouping of members/tasks within an event/org. This is the single
// source of truth for the shape; member-service will own the write model and expose
// the list API, while read consumers (FE4 gantt, mobile, …) depend on this type so
// they can be re-pointed at that API without changing their code.
import type { TeamId } from "./common";

export interface Team {
  id: TeamId;
  /** URL/query-safe stable slug (e.g. "ops", "content"). Unique within scope. */
  key: string;
  name: string;
  /** Optional accent colour (hex or token name) for chips/bars. */
  color?: string;
  /** 2-letter uppercase team code used as the prefix of task IDs owned by this
   *  team (e.g. "TK" ⇒ TK-0001). When absent, consumers fall back to a canonical
   *  key→code map. Additive/optional (member-service will own the write model). */
  code?: string;
  description?: string;
}

export interface TeamSummary {
  id: TeamId;
  key: string;
  name: string;
  color?: string;
  /** 2-letter uppercase task-ID prefix code (see Team.code). Additive/optional. */
  code?: string;
}

export interface ListTeamsResponse {
  items: Team[];
}
