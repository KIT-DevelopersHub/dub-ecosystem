// 参加届 feature — public surface for the shell composition (featureModules.tsx).
export { createParticipationApi } from "./participationApi.tsx";
export type { ParticipationApi } from "./participationApi.tsx";
export { ParticipationProvider, ParticipationApiProvider, useParticipationApi } from "./ParticipationProvider.tsx";
export { ParticipationPage } from "./ParticipationPage.tsx";
export { participationRoutes, participationNav } from "./module.tsx";
export type { ParticipationSourceRoute, ParticipationNavEntry } from "./module.tsx";
export type {
  Participation,
  ParticipationMatchKind,
  DesiredActivity,
  Grade,
  MemberTeam,
  SubmitParticipationRequest,
  SubmitParticipationResponse,
  ListParticipationsResponse,
} from "./contracts.ts";
