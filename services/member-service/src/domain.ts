// Pure domain helpers: DTO mappers (row -> canonical @dub/types wire) + slug/validation.
import type { member } from "@dub/types";
import type { MemberStatus, PersonRow, TeamRow } from "./types";
import { MEMBER_STATUSES } from "./types";

export const SORT_ORDER_GAP = 1024;
export const MAX_NAME_LEN = 200;

export function isMemberStatus(v: unknown): v is MemberStatus {
  return typeof v === "string" && (MEMBER_STATUSES as readonly string[]).includes(v);
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
    department: r.department,
    grade: r.grade,
    identityUserId: r.identityUserId,
    contact: r.contact,
    note: r.note,
    sortOrder: r.sortOrder,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
