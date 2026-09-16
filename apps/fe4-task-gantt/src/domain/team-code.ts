// Canonical team taxonomy + the 2-letter code that prefixes each task's number.
//
// A task's number prefix is DERIVED from its owning team (r.teamId → team.Team),
// not a single free-text input — so every team shows its own correct code instead
// of one shared value. This module is the single source of truth for the 9
// official conference teams and their codes, plus a resolver that maps any team
// (canonical or a pre-rename legacy name/key) to its code, so historical task
// data keeps a sensible, stable-looking prefix.
//
// The `key`/`name` values below are copied VERBATIM from production D1 `dub-core`
// (`member_teams`, org_devhub, read via the Cloudflare D1 HTTP API on 2026-09-16) —
// they are the real, currently-live team rows, not an invented taxonomy:
//   exec / 統括チーム · dev / 開発チーム · ops / 当日運営チーム · sponsor / スポンサーチーム ·
//   venue / セッションチーム · finance / 法務会計チーム · pr / 集客広報チーム · design / デザインチーム
// Two renames already happened in prod under the SAME key (name changed, key didn't):
// `venue` is now displayed "セッションチーム" (was 会場) and `ops` is now "当日運営チーム"
// (was 当日進行) — see LEGACY_ALIAS for the pre-rename names.
// 法人メンバー(HM) has NO row in prod today — it is kept here only because it is part
// of the confirmed 9-code taxonomy for when that team is created; until then no live
// team ever resolves to HM.
import type { team, common } from "@dub/types";

/** One official team: stable slug + display name (verbatim from prod) + 2-letter code. */
export interface CanonicalTeam {
  key: string;
  name: string;
  /** 2-letter uppercase code (統括チーム ⇒ TK, 法務会計チーム ⇒ HK, …). */
  code: string;
}

// The 9 official teams. Codes are contractual and must not be re-lettered casually:
// 統括=TK / 法務会計=HK / セッション=SE / 当日運営=TU / スポンサー=SP / 集客広報=SK /
// デザイン=DS / 法人メンバー=HM / 開発=KH (開発 is its OWN team/code — it is no longer
// folded into 統括; see LEGACY_ALIAS's history note below).
export const CANONICAL_TEAMS: readonly CanonicalTeam[] = [
  { key: "exec", name: "統括チーム", code: "TK" },
  { key: "dev", name: "開発チーム", code: "KH" },
  { key: "ops", name: "当日運営チーム", code: "TU" },
  { key: "sponsor", name: "スポンサーチーム", code: "SP" },
  { key: "venue", name: "セッションチーム", code: "SE" },
  { key: "finance", name: "法務会計チーム", code: "HK" },
  { key: "pr", name: "集客広報チーム", code: "SK" },
  { key: "design", name: "デザインチーム", code: "DS" },
  // Not yet in prod (no member_teams row as of 2026-09-16) — placeholder key.
  { key: "houjinmember", name: "法人メンバー", code: "HM" },
] as const;

const CODE_BY_KEY = new Map(CANONICAL_TEAMS.map((t) => [t.key, t.code] as const));
const CODE_BY_NAME = new Map(CANONICAL_TEAMS.map((t) => [normalizeTeamName(t.name), t.code] as const));

// Pre-rename / pre-taxonomy team names & keys, mapped onto today's codes so
// existing task assignments keep a stable prefix:
//  - 会場→セッション and 当日進行→当日運営 are IN-PLACE prod renames (the row's `key`
//    stayed `venue`/`ops`; only the displayed `name` changed) — these entries cover
//    seed/demo data that was never updated past the old name.
//  - 本部/soukatsu/honbu→統括, 会計/kaikei→法務会計, 全体進行/shinko→当日運営,
//    集客告知→集客広報 are earlier legacy names/keys seen in seed/demo data
//    (apps/fe4-task-gantt/src/dev-seed.ts, apps/fe2-app-shell/src/lib/demo-seed.tsx)
//    from before the 8/9-team taxonomy existed.
// NOTE: 開発/dev is NOT here — it is now its OWN canonical team (code KH), not an
// alias for 統括 any more.
const LEGACY_ALIAS: Record<string, string> = {
  会場: "SE", kaijou: "SE",
  当日進行: "TU",
  本部: "TK", honbu: "TK", soukatsu: "TK",
  会計: "HK", kaikei: "HK",
  全体進行: "TU", shinko: "TU",
  集客告知: "SK",
};

/** Demo/seed data sometimes omits (or, historically, appended) the "チーム" suffix
 *  prod names always carry (e.g. prod "開発チーム" vs. an old fixture's "開発") —
 *  normalize both sides the same way before matching by name so either form
 *  resolves instead of silently falling through to "". */
function normalizeTeamName(name: string): string {
  return name.trim().replace(/チーム$/, "");
}

/** Resolve a team's 2-letter code. Precedence: canonical key → canonical name
 *  (normalized) → legacy key/name alias (also normalized). Returns "" when
 *  nothing matches (numbering then omits the prefix), so an unknown/team-less
 *  task never loses its number. */
export function teamCode(t: team.Team | team.TeamSummary | null | undefined): string {
  if (!t) return "";
  const name = normalizeTeamName(t.name);
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
