// Pure domain helpers: DTO mappers (row -> canonical @dub/types wire) + slug/validation.
import { member } from "@dub/types";
import type { MemberStatus, ParticipationRow, PersonRow, TeamRow } from "./types";
import { MEMBER_STATUSES } from "./types";

export const SORT_ORDER_GAP = 1024;
export const MAX_NAME_LEN = 200;

export function isMemberStatus(v: unknown): v is MemberStatus {
  return typeof v === "string" && (MEMBER_STATUSES as readonly string[]).includes(v);
}

export function isGrade(v: unknown): v is member.Grade {
  return typeof v === "string" && (member.GRADES as readonly string[]).includes(v);
}

export function isDesiredActivity(v: unknown): v is member.DesiredActivity {
  return typeof v === "string" && (member.DESIRED_ACTIVITIES as readonly string[]).includes(v);
}

/** Fold a personal name to a stable matching key that absorbs 表記ゆれ: strips all
 *  whitespace (half/full-width incl. the ideographic space U+3000), lowercases ASCII,
 *  and NFKC-normalizes so full-width latin/space variants collapse. Non-destructive:
 *  used only for comparison/dedupe, never shown. */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .toLowerCase();
}

/** URL-safe slug from a team name. ASCII names slugify; non-ASCII (e.g. Japanese)
 *  yields "" and the caller falls back to a generated key. */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function toTeam(r: TeamRow): member.Team {
  return { id: r.id, key: r.key, name: r.name, color: r.color, description: r.description };
}

export function toMember(r: PersonRow, teamIds: string[]): member.Member {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    roleTitle: r.roleTitle,
    status: r.status,
    teamIds,
    contact: r.contact,
    note: r.note,
    sortOrder: r.sortOrder,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toParticipation(r: ParticipationRow): member.Participation {
  return {
    id: r.id,
    orgId: r.orgId,
    memberId: r.memberId,
    name: r.name,
    nameKana: r.nameKana,
    grade: r.grade,
    department: r.department,
    contact: r.contact,
    desiredTeamId: r.desiredTeamId,
    desiredActivity: r.desiredActivity,
    note: r.note,
    status: r.status,
    matchKind: r.matchKind,
    submittedBy: r.submittedBy,
    submittedAt: r.submittedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
