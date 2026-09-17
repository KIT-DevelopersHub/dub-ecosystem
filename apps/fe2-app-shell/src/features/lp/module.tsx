// LP管理 FeatureModule source (mail/usage と同じく FE2 ローカル feature)。
// composition (featureModules.tsx) が nav の順序を束ね、withAppAccessGate が
// app:lp:view を各ルート/タイルに AND する（実際の per-app ゲート）。バックエンド依存が
// ないため Provider は不要（静的なバージョンカタログを読むだけ）。1 ルート:
//   /lp → LP バージョン一覧（各行の「見る」で公開 LP を新規タブ表示）
// auth:"required" なので未ログインはシェルが /login に戻す。
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { LpManagementScreen } from "./LpManagementScreen.tsx";

export interface LpSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
}
export interface LpNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const lpRoutes: LpSourceRoute[] = [
  { path: "/lp", lazy: () => Promise.resolve({ Component: LpManagementScreen }), auth: "required" },
];

export const lpNav: LpNavEntry[] = [{ label: "LP管理", path: "/lp", icon: "megaphone" }];
