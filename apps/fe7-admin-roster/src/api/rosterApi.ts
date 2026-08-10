// Typed façade over FE2's ResourceClient. All paths go through the gateway
// `/api/v1/*` boundary (design §2-4). This unit implements against the contract
// types only; the concrete transport (auth cookie, base URL, error reconstruction)
// is FE2's ResourceClient.
import type { identity, common, auditLog } from "@dub/types";
import type { ResourceClient } from "../shell/contract";
import type {
  CreateRoleRequest,
  UpdateRoleRequest,
  AssignRoleRequest,
  RoleAssignment,
  EmailRoutingAddress,
  CreateEmailAddressRequest,
  UpdateEmailAddressRequest,
} from "../contracts/pending";
import { buildListUsersParams, type UserListFilters } from "../lib/listUsersQuery";
import { buildAuditQuery, type AuditFilters } from "../lib/auditQuery";
import type { MailStatusResponse } from "../lib/mailStatus";

const BASE = "/api/v1";
const IDENTITY = `${BASE}/identity`;
const EMAIL_ROUTING = `${BASE}/admin/email-routing`;

export interface RosterApi {
  listUsers(filters: UserListFilters): Promise<common.Paginated<identity.IdentityUser>>;
  getUserSummaries(ids: readonly common.UserId[]): Promise<common.Paginated<identity.IdentityUser>>;
  getUser(id: common.UserId): Promise<identity.IdentityUserDetail>;
  patchUser(
    id: common.UserId,
    patch: { displayName?: string; status?: identity.UserStatus; githubLogin?: string | null },
  ): Promise<identity.IdentityUser>;
  inviteUser(req: identity.InviteUserRequest): Promise<identity.IdentityUser>;
  listRoles(): Promise<common.Paginated<identity.Role>>;
  createRole(req: CreateRoleRequest): Promise<identity.Role>;
  updateRole(id: common.RoleId, req: UpdateRoleRequest): Promise<identity.Role>;
  deleteRole(id: common.RoleId): Promise<void>;
  listUserRoles(userId: common.UserId): Promise<RoleAssignment[]>;
  assignRole(userId: common.UserId, req: AssignRoleRequest): Promise<RoleAssignment>;
  revokeRole(userId: common.UserId, assignmentId: string): Promise<void>;
  permissionCatalog(): Promise<identity.PermissionCatalogEntry[]>;
  auditLogs(filters: AuditFilters): Promise<auditLog.AuditLogPage>;
  /** Mail-gateway rate-limit status, via the gateway boundary (proxied to /internal/status). */
  mailStatus(): Promise<MailStatusResponse>;
  // ---- Email Routing (@developershub.jp address management) ----
  listEmailAddresses(): Promise<common.Paginated<EmailRoutingAddress>>;
  createEmailAddress(req: CreateEmailAddressRequest): Promise<EmailRoutingAddress>;
  updateEmailAddress(id: string, req: UpdateEmailAddressRequest): Promise<EmailRoutingAddress>;
  deleteEmailAddress(id: string): Promise<void>;
}

export function createRosterApi(client: ResourceClient): RosterApi {
  return {
    listUsers: (filters) =>
      client.get<common.Paginated<identity.IdentityUser>>(
        `${IDENTITY}/users`,
        buildListUsersParams(filters),
      ),
    getUserSummaries: (ids) =>
      client.get<common.Paginated<identity.IdentityUser>>(`${IDENTITY}/users`, {
        ids: [...ids].join(","),
      }),
    getUser: (id) => client.get<identity.IdentityUserDetail>(`${IDENTITY}/users/${id}`),
    patchUser: (id, patch) => client.patch<identity.IdentityUser>(`${IDENTITY}/users/${id}`, patch),
    inviteUser: (req) => client.post<identity.IdentityUser>(`${IDENTITY}/users/invite`, req),
    listRoles: () => client.get<common.Paginated<identity.Role>>(`${IDENTITY}/roles`),
    createRole: (req) => client.post<identity.Role>(`${IDENTITY}/roles`, req),
    updateRole: (id, req) => client.patch<identity.Role>(`${IDENTITY}/roles/${id}`, req),
    deleteRole: (id) => client.delete(`${IDENTITY}/roles/${id}`),
    listUserRoles: (userId) => client.get<RoleAssignment[]>(`${IDENTITY}/users/${userId}/roles`),
    assignRole: (userId, req) =>
      client.post<RoleAssignment>(`${IDENTITY}/users/${userId}/roles`, req),
    revokeRole: (userId, assignmentId) =>
      client.delete(`${IDENTITY}/users/${userId}/roles/${assignmentId}`),
    permissionCatalog: () =>
      client.get<identity.PermissionCatalogEntry[]>(`${IDENTITY}/permissions/catalog`),
    auditLogs: (filters) =>
      client.get<auditLog.AuditLogPage>(`${BASE}/audit/logs`, { ...buildAuditQuery(filters) }),
    mailStatus: () => client.get<MailStatusResponse>(`${BASE}/mail/status`),
    listEmailAddresses: () => client.get<common.Paginated<EmailRoutingAddress>>(`${EMAIL_ROUTING}/addresses`),
    createEmailAddress: (req) => client.post<EmailRoutingAddress>(`${EMAIL_ROUTING}/addresses`, req),
    updateEmailAddress: (id, req) => client.patch<EmailRoutingAddress>(`${EMAIL_ROUTING}/addresses/${id}`, req),
    deleteEmailAddress: (id) => client.delete(`${EMAIL_ROUTING}/addresses/${id}`),
  };
}
