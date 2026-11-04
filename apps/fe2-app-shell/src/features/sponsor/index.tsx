// スポンサー feature — composition (featureModules.tsx) 向けの公開面。
export { sponsorRoutes, sponsorNav } from "./module.tsx";
export type { SponsorSourceRoute, SponsorNavEntry } from "./module.tsx";
export { SponsorProvider, SponsorApiProvider, useSponsorApi } from "./SponsorProvider.tsx";
export { createSponsorApi } from "./sponsorApi.tsx";
export type { SponsorApi } from "./sponsorApi.tsx";
