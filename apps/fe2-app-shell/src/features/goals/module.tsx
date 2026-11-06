// 目標管理 FeatureModule source (スポンサーと同じく FE2 ローカル feature)。composition が GoalsProvider で
// 包み、withAppAccessGate が app:goals:view を各ルート/タイルに AND する。
// 未公開アプリ (releaseGate PUBLISHED_APPS 外) なので admin 以外はランチャーでグレー表示。
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { GoalsScreen } from "./GoalsScreen.tsx";

export interface GoalsSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
}
export interface GoalsNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const goalsRoutes: GoalsSourceRoute[] = [
  { path: "/goals", lazy: () => Promise.resolve({ Component: GoalsScreen }), auth: "required" },
];

export const goalsNav: GoalsNavEntry[] = [{ label: "目標管理", path: "/goals", icon: "flag" }];
