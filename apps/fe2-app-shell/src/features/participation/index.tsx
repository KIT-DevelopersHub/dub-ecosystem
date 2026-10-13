// 参加届 feature — public surface for the shell composition (featureModules.tsx).
export { createParticipationApi } from "./participationApi.tsx";
export type { ParticipationApi } from "./participationApi.tsx";
export { ParticipationProvider, ParticipationApiProvider, useParticipationApi } from "./ParticipationProvider.tsx";
export { OnboardingAdminPage } from "./OnboardingAdminPage.tsx";
export { PublicOnboardingPage } from "./PublicOnboardingPage.tsx";
export { ParticipationListPage } from "./ParticipationListPage.tsx";
export { PublicParticipationPage } from "./PublicParticipationPage.tsx";
export { ParticipationForm } from "./ParticipationForm.tsx";
export { PUBLIC_ONBOARDING_PATH, PUBLIC_PARTICIPATION_PATH, participationRoutes, participationNav } from "./module.tsx";
export type { ParticipationSourceRoute, ParticipationNavEntry } from "./module.tsx";
export type {
  OnboardingItem,
  Participation,
  ParticipationMatchKind,
  DesiredActivity,
  Grade,
  MemberTeam,
  SubmitParticipationRequest,
  SubmitParticipationResponse,
  ListParticipationsResponse,
} from "./contracts.ts";
