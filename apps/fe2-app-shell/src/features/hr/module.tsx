// 人事 FeatureModule source (LP管理 と同じく FE2 ローカル feature)。composition が HrProvider で
// 包み、withAppAccessGate が app:hr:view を各ルート/タイルに AND する (実際の per-app ゲート)。
// 未公開アプリ (releaseGate PUBLISHED_APPS 外) なので admin 以外はランチャーでグレー表示。
//   /hr            → パイプライン (カンバン)
//   /hr/list       → 応募者一覧
//   /hr/onboarding → 新メンバーのオンボーディング (チェックリスト)
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { HrListScreen, HrPipelineScreen } from "./HrPipelineScreen.tsx";
import { HrOnboardingScreen } from "./HrOnboardingScreen.tsx";

export interface HrSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
}
export interface HrNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const hrRoutes: HrSourceRoute[] = [
  { path: "/hr", lazy: () => Promise.resolve({ Component: HrPipelineScreen }), auth: "required" },
  { path: "/hr/list", lazy: () => Promise.resolve({ Component: HrListScreen }), auth: "required" },
  { path: "/hr/onboarding", lazy: () => Promise.resolve({ Component: HrOnboardingScreen }), auth: "required" },
];

export const hrNav: HrNavEntry[] = [{ label: "人事", path: "/hr", icon: "user" }];
