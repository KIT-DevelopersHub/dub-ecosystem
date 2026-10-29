// 人事 FeatureModule source (LP管理 と同じく FE2 ローカル feature)。composition が HrProvider で
// 包み、withAppAccessGate が app:hr:view を各ルート/タイルに AND する (実際の per-app ゲート)。
// 未公開アプリ (releaseGate PUBLISHED_APPS 外) なので admin 以外はランチャーでグレー表示。
//   /hr            → 応募者 (表・ステータス絞り込み・その場でステータス変更)
//   /hr/onboarding → 新メンバーのオンボーディング (チェックリスト)
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { HrApplicantsScreen } from "./HrApplicantsScreen.tsx";
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
  { path: "/hr", lazy: () => Promise.resolve({ Component: HrApplicantsScreen }), auth: "required" },
  { path: "/hr/onboarding", lazy: () => Promise.resolve({ Component: HrOnboardingScreen }), auth: "required" },
];

export const hrNav: HrNavEntry[] = [{ label: "人事", path: "/hr", icon: "user" }];
