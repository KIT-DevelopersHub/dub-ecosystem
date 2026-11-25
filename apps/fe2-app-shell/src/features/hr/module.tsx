// 人事 FeatureModule source (LP管理 と同じく FE2 ローカル feature)。composition が HrProvider で
// 包み、withAppAccessGate が app:hr:view を各ルート/タイルに AND する (実際の per-app ゲート)。
// 未公開アプリ (releaseGate PUBLISHED_APPS 外) なので admin 以外はランチャーでグレー表示。
//   /hr            → 応募者 (表・ステータス絞り込み・その場でステータス変更)
//   /hr/form       → 面談申し込みフォーム (編集・公開 URL・回答・代理入力)
//   /hr/interviews → 面談 (面談できる日程の登録・案内メールの状況と保留の設定)
//   /hr/onboarding → 新メンバーのオンボーディング (チェックリスト)
//   /hr/attendance → 全体定例・チーム定例の出席 (Dub から Meet に参加した人を記録)
// 参加届の回答 (/participation/list) と オンボーディング案内 (/participation) も人事のタブに並ぶが、
// ルート・Provider・per-app ゲート (app:participation:view) は参加届モジュール側のまま。
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { HrApplicantsScreen } from "./HrApplicantsScreen.tsx";
import { HrInterviewFormScreen } from "./HrInterviewFormScreen.tsx";
import { HrInterviewsScreen } from "./HrInterviewsScreen.tsx";
import { HrOnboardingScreen } from "./HrOnboardingScreen.tsx";
import { HrAttendanceScreen } from "./HrAttendanceScreen.tsx";

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
  { path: "/hr/form", lazy: () => Promise.resolve({ Component: HrInterviewFormScreen }), auth: "required" },
  { path: "/hr/interviews", lazy: () => Promise.resolve({ Component: HrInterviewsScreen }), auth: "required" },
  { path: "/hr/onboarding", lazy: () => Promise.resolve({ Component: HrOnboardingScreen }), auth: "required" },
  { path: "/hr/attendance", lazy: () => Promise.resolve({ Component: HrAttendanceScreen }), auth: "required" },
];

export const hrNav: HrNavEntry[] = [{ label: "人事", path: "/hr", icon: "user" }];
