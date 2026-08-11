// Pure domain helpers: DTO mappers (row -> wire) + validation constants.
import type { MemberStatus, MemberTeam, OrgMember, PersonRow, TeamRow } from "./types";
import { MEMBER_STATUSES } from "./types";

export const SORT_ORDER_GAP = 1024;
export const MAX_NAME_LEN = 200;

export function isMemberStatus(v: unknown): v is MemberStatus {
  return typeof v === "string" && (MEMBER_STATUSES as readonly string[]).includes(v);
}

export function toMemberTeam(r: TeamRow): MemberTeam {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    description: r.description,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toOrgMember(r: PersonRow, teamIds: string[]): OrgMember {
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
