// Members feature — public surface for the shell composition (featureModules.tsx).
export { createMembersApi } from "./membersApi.tsx";
export type { MembersApi } from "./membersApi.tsx";
export { MembersProvider, MembersApiProvider, useMembersApi } from "./MembersProvider.tsx";
export { MembersPage } from "./MembersPage.tsx";
export { MemberRosterNav } from "./MemberRosterNav.tsx";
export { MemberStatusBadge, STATUS_LABEL } from "./MemberStatusBadge.tsx";
export { membersRoutes, membersNav } from "./module.tsx";
export type { MembersSourceRoute, MembersNavEntry } from "./module.tsx";
export type {
  MemberStatus,
  MemberTeam,
  OrgMember,
  MembersOverview,
  CreateTeamRequest,
  UpdateTeamRequest,
  CreateMemberRequest,
  UpdateMemberRequest,
} from "./contracts.ts";
export { MEMBER_STATUSES } from "./contracts.ts";
