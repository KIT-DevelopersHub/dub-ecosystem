// 人事 feature — composition (featureModules.tsx) 向けの公開面。
export { hrRoutes, hrNav } from "./module.tsx";
export type { HrSourceRoute, HrNavEntry } from "./module.tsx";
export { HrProvider, HrApiProvider, useHrApi } from "./HrProvider.tsx";
export { createHrApi } from "./hrApi.tsx";
export type { HrApi } from "./hrApi.tsx";
