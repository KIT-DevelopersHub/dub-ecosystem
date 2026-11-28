// 会計 FeatureModule source (FE2 ローカル feature)。composition が AccountingProvider で包み、
// withAppAccessGate が app:accounting:view を各ルート/タイルに AND する。
// 未公開アプリ (releaseGate PUBLISHED_APPS 外) なので admin 以外はランチャーでグレー表示。
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { AccountingScreen } from "./AccountingScreen.tsx";

export interface AccountingSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
}
export interface AccountingNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const accountingRoutes: AccountingSourceRoute[] = [
  { path: "/accounting", lazy: () => Promise.resolve({ Component: AccountingScreen }), auth: "required" },
];

export const accountingNav: AccountingNavEntry[] = [{ label: "会計", path: "/accounting", icon: "file" }];
