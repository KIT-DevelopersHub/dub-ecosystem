// Members feature api adapter. Like mail (and FE3–FE7's clients) it rides the ONE
// shell api-client (src/lib/api-client.tsx): session cookie, 401→refresh, requestId,
// error normalization. Callers never write fetch. All paths are /api/v1/members/*
// and resolve at the gateway to services/member-service.
import type { ApiClient } from "../../lib/api-client.tsx";
import type {
  CreateMemberRequest,
  CreateTeamRequest,
  MembersOverview,
  MemberTeam,
  OrgMember,
  UpdateMemberRequest,
  UpdateTeamRequest,
} from "./contracts.ts";

export interface MembersApi {
  /** Everything the three views need in one call (members:read). */
  getOverview(): Promise<MembersOverview>;
  createTeam(input: CreateTeamRequest): Promise<MemberTeam>;
  updateTeam(id: string, patch: UpdateTeamRequest): Promise<MemberTeam>;
  deleteTeam(id: string): Promise<void>;
  createMember(input: CreateMemberRequest): Promise<OrgMember>;
  updateMember(id: string, patch: UpdateMemberRequest): Promise<OrgMember>;
  deleteMember(id: string): Promise<void>;
}

const BASE = "/api/v1/members";

export function createMembersApi(api: ApiClient): MembersApi {
  return {
    getOverview: () => api.request<MembersOverview>({ method: "GET", path: `${BASE}/overview` }),
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
  };
}
