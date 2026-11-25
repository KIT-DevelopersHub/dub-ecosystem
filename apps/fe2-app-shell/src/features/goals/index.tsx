// 目標管理 feature — composition (featureModules.tsx) 向けの公開面。
export { goalsRoutes, goalsNav } from "./module.tsx";
export type { GoalsSourceRoute, GoalsNavEntry } from "./module.tsx";
export { GoalsProvider, GoalsApiProvider, useGoalsApi } from "./GoalsProvider.tsx";
export { createGoalsApi } from "./goalsApi.tsx";
export type { GoalsApi } from "./goalsApi.tsx";
