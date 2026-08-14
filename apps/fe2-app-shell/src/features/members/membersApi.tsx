// Members feature api adapter. Like mail (and FE3–FE7's clients) it rides the ONE
// shell api-client (src/lib/api-client.tsx): session cookie, 401→refresh, requestId,
// error normalization. Callers never write fetch. All paths are /api/v1/members/*
// and resolve at the gateway to services/member-service.
import type { common, identity, member } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";
import type {
  CreateMemberRequest,
  CreateTeamRequest,
  LinkIdentityRequest,
  MembersOverview,
  MemberTeam,
  OrgMember,
  UpdateMemberRequest,
  UpdateTeamRequest,
} from "./contracts.ts";

export interface MembersApi {
  /** Everything the three views need in one call (identity:read). */
  getOverview(): Promise<MembersOverview>;
  /** Canonical team list — the source other apps read (identity:read). */
  listTeams(): Promise<member.ListTeamsResponse>;
  createTeam(input: CreateTeamRequest): Promise<MemberTeam>;
  updateTeam(id: string, patch: UpdateTeamRequest): Promise<MemberTeam>;
  deleteTeam(id: string): Promise<void>;
  createMember(input: CreateMemberRequest): Promise<OrgMember>;
  updateMember(id: string, patch: UpdateMemberRequest): Promise<OrgMember>;
  deleteMember(id: string): Promise<void>;
  /** Link (or unlink with identityUserId=null via updateMember) a member to a login
   *  account. Human-confirmed; the candidate list comes from listIdentityUsers. */
  linkIdentity(id: string, input: LinkIdentityRequest): Promise<OrgMember>;
  /** Roster login accounts (identity:read) — the candidate pool for the link dialog. */
  listIdentityUsers(): Promise<common.Paginated<identity.IdentityUser>>;
}

const BASE = "/api/v1/members";

export function createMembersApi(api: ApiClient): MembersApi {
  return {
    getOverview: () => api.request<MembersOverview>({ method: "GET", path: `${BASE}/overview` }),
    listTeams: () => api.request<member.ListTeamsResponse>({ method: "GET", path: `${BASE}/teams` }),
    createTeam: (input) =>
      api.request<MemberTeam, CreateTeamRequest>({ method: "POST", path: `${BASE}/teams`, body: input }),
    updateTeam: (id, patch) =>
      api.request<MemberTeam, UpdateTeamRequest>({ method: "PATCH", path: `${BASE}/teams/${encodeURIComponent(id)}`, body: patch }),
    deleteTeam: async (id) => {
      await api.request<{ ok: true }>({ method: "DELETE", path: `${BASE}/teams/${encodeURIComponent(id)}` });
    },
    createMember: (input) =>
      api.request<OrgMember, CreateMemberRequest>({ method: "POST", path: `${BASE}/people`, body: input }),
    updateMember: (id, patch) =>
      api.request<OrgMember, UpdateMemberRequest>({ method: "PATCH", path: `${BASE}/people/${encodeURIComponent(id)}`, body: patch }),
    deleteMember: async (id) => {
      await api.request<{ ok: true }>({ method: "DELETE", path: `${BASE}/people/${encodeURIComponent(id)}` });
    },
    linkIdentity: (id, input) =>
      api.request<OrgMember, LinkIdentityRequest>({ method: "POST", path: `${BASE}/people/${encodeURIComponent(id)}/identity-link`, body: input }),
    listIdentityUsers: () =>
      api.request<common.Paginated<identity.IdentityUser>>({ method: "GET", path: `/api/v1/identity/users` }),
  };
}
