// Canonical team taxonomy + the 2-letter code that prefixes each task's number.
//
// A task's number prefix is DERIVED from its owning team (r.teamId → team.Team),
// not a single free-text input — so every team shows its own correct code instead
// of one shared value. This module is the single source of truth for the 8
// official conference teams and their codes, plus a resolver that maps any team
// (canonical or a pre-rename legacy name/key) to its code, so historical task
// data keeps a sensible, stable-looking prefix.
import type { team, common } from "@dub/types";

/** One official team: stable slug + display name + 2-letter code. */
export interface CanonicalTeam {
  key: string;
  name: string;
  /** 2-letter uppercase code (統括 ⇒ TK, 法務会計 ⇒ HK, …). */
  code: string;
}

// The 8 official teams. Codes are contractual and must not be re-lettered
// casually: 統括=TK / 法務会計=HK / セッション=SE / 当日運営=TU / スポンサー=SP /
// 集客広報=SK / デザイン=DS / 法人メンバー=HM.
// セッション/当日運営 are the current names for the former 会場/当日進行 teams
// (see LEGACY_ALIAS below for the old names/keys).
export const CANONICAL_TEAMS: readonly CanonicalTeam[] = [
  { key: "toukatsu", name: "統括", code: "TK" },
  { key: "houmukaikei", name: "法務会計", code: "HK" },
  { key: "session", name: "セッション", code: "SE" },
  { key: "toujitsuunei", name: "当日運営", code: "TU" },
  { key: "sponsor", name: "スポンサー", code: "SP" },
  { key: "shukkyakukouhou", name: "集客広報", code: "SK" },
  { key: "design", name: "デザイン", code: "DS" },
  { key: "houjinmember", name: "法人メンバー", code: "HM" },
] as const;

const CODE_BY_KEY = new Map(CANONICAL_TEAMS.map((t) => [t.key, t.code] as const));
const CODE_BY_NAME = new Map(CANONICAL_TEAMS.map((t) => [t.name, t.code] as const));

// Pre-taxonomy / pre-rename team names & keys, mapped onto today's codes so
// existing task assignments keep a stable prefix. 会場→セッション and
// 当日進行→当日運営 are the two renames named by this fix; 本部/開発/soukatsu→統括,
// 会計→法務会計, 全体進行/ops→当日運営, 集客告知→集客広報 are earlier legacy names
// seen in seed/demo data (apps/fe4-task-gantt/src/dev-seed.ts,
// apps/fe2-app-shell/src/lib/demo-seed.tsx).
const LEGACY_ALIAS: Record<string, string> = {
  会場: "SE", venue: "SE", kaijou: "SE",
  当日進行: "TU", toujitsu: "TU", ops: "TU",
  本部: "TK", honbu: "TK", soukatsu: "TK",
  開発: "TK", dev: "TK",
  会計: "HK", kaikei: "HK",
  全体進行: "TU", shinko: "TU",
  集客告知: "SK", pr: "SK",
};

/** Demo/seed data sometimes appends "チーム" to an otherwise-canonical/legacy name
 *  (e.g. "統括チーム", "会場チーム") — strip it before matching by name so those
 *  still resolve instead of silently falling through to "". */
function stripTeamSuffix(name: string): string {
  return name.replace(/チーム$/, "");
}

/** Resolve a team's 2-letter code. Precedence: canonical key → canonical name →
 *  legacy key/name alias (name matched with a trailing "チーム" stripped too).
 *  Returns "" when nothing matches (numbering then omits the prefix), so an
 *  unknown/team-less task never loses its number. */
export function teamCode(t: team.Team | team.TeamSummary | null | undefined): string {
  if (!t) return "";
  const name = stripTeamSuffix(t.name);
  return (
    CODE_BY_KEY.get(t.key) ??
    CODE_BY_NAME.get(name) ??
    LEGACY_ALIAS[t.key] ??
    LEGACY_ALIAS[name] ??
    ""
  );
}

/** Resolve a team code from a teamId given a lookup of the loaded teams. */
export function teamCodeById(
  teamId: common.TeamId | null | undefined,
  teamsById: ReadonlyMap<common.TeamId, team.Team | team.TeamSummary>,
): string {
  if (!teamId) return "";
  return teamCode(teamsById.get(teamId));
}
