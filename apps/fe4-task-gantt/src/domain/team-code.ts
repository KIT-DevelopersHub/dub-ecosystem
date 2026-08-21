// Canonical team taxonomy + the 2-letter code that prefixes every task ID.
//
// A task's ID is `<team code>-<global creation sequence>` (e.g. "TK-0001"). The
// code is DERIVED from the task's owning team — not a single free-text prefix — so
// re-assigning a team changes the prefix automatically. This module is the single
// source of truth for the 8 official conference teams and their codes, plus a
// resolver that maps any team (canonical, legacy, or member-service-provided) to
// its code, so historical team ids keep resolving to a sensible prefix.
import type { team, common } from "@dub/types";

/** One official team: stable slug + display name + 2-letter ID code + chip colour. */
export interface CanonicalTeam {
  key: string;
  name: string;
  /** 2-letter uppercase ID prefix (統括 ⇒ TK, 法務会計 ⇒ HK, …). */
  code: string;
  color: string;
  description: string;
}

// The 8 official teams. This is the正式タクソノミ; the codes are contractual
// (統括=TK / 法務会計=HK / 会場=KJ / 当日進行=TS / スポンサー=SP / 集客広報=SK /
// デザイン=DS / 法人メンバー=HJ) and must not be re-lettered casually.
export const CANONICAL_TEAMS: readonly CanonicalTeam[] = [
  { key: "toukatsu", name: "統括", code: "TK", color: "#1e3a5f", description: "全体統括・意思決定・進行統制" },
  { key: "houmukaikei", name: "法務会計", code: "HK", color: "#7c3aed", description: "法人・法務・予算・会計運用" },
  { key: "kaijou", name: "会場", code: "KJ", color: "#16a34a", description: "会場・設営・ネットワーク／配信" },
  { key: "toujitsu", name: "当日進行", code: "TS", color: "#2563eb", description: "進行管理・当日運営・定例運営" },
  { key: "sponsor", name: "スポンサー", code: "SP", color: "#ea580c", description: "協賛打診・契約" },
  { key: "shukkyaku", name: "集客広報", code: "SK", color: "#db2777", description: "LP・SNS・広報／集客" },
  { key: "design", name: "デザイン", code: "DS", color: "#0d9488", description: "ブランド・制作物・UIデザイン" },
  { key: "houjin", name: "法人メンバー", code: "HJ", color: "#6366f1", description: "法人メンバー" },
] as const;

const CODE_BY_KEY = new Map(CANONICAL_TEAMS.map((t) => [t.key, t.code] as const));
const CODE_BY_NAME = new Map(CANONICAL_TEAMS.map((t) => [t.name, t.code] as const));

// Legacy conference teams (pre-8-team taxonomy) mapped onto the official codes so
// existing task assignments keep a stable prefix. 会計→法務会計, 本部/開発→統括
// (no standalone dev team in the taxonomy), 全体進行→当日進行, 集客告知→集客広報.
const LEGACY_ALIAS: Record<string, string> = {
  honbu: "TK", 本部: "TK",
  shinko: "TS", 全体進行: "TS",
  dev: "TK", 開発: "TK",
  sponsor: "SP", スポンサー: "SP",
  venue: "KJ", 会場: "KJ",
  kaikei: "HK", 会計: "HK",
  pr: "SK", 集客告知: "SK",
};

/** Resolve a team's 2-letter ID code. Precedence: an explicit `code` on the team →
 *  canonical key → canonical name → legacy alias → first two ASCII letters of the
 *  key. Returns "" only when nothing usable is found (numbering then omits the
 *  prefix), so an unknown/team-less task never loses its number. */
export function teamCode(team: team.Team | team.TeamSummary | null | undefined): string {
  if (!team) return "";
  const explicit = normalizeCode(team.code);
  if (explicit) return explicit;
  const mapped =
    CODE_BY_KEY.get(team.key) ??
    CODE_BY_NAME.get(team.name) ??
    LEGACY_ALIAS[team.key] ??
    LEGACY_ALIAS[team.name];
  if (mapped) return mapped;
  const letters = (team.key ?? "").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
  return letters.length === 2 ? letters : "";
}

/** Resolve a team code from a teamId given a lookup of the loaded teams. */
export function teamCodeById(
  teamId: common.TeamId | null | undefined,
  teamsById: ReadonlyMap<common.TeamId, team.Team | team.TeamSummary>,
): string {
  if (!teamId) return "";
  return teamCode(teamsById.get(teamId));
}

function normalizeCode(code: string | undefined): string {
  if (!code) return "";
  const c = code.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
  return c.length === 2 ? c : "";
}
