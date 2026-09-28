// LP管理 FeatureModule source (mail/usage と同じく FE2 ローカル feature)。
// composition (featureModules.tsx) が nav の順序を束ね、withAppAccessGate が
// app:lp:view を各ルート/タイルに AND する（実際の per-app ゲート）。ルートは 2 つ:
//   /lp        → LP バージョン一覧（各行の「見る」で公開 LP を新規タブ表示・静的カタログ）
//   /lp/visits → ログ管理（流入ログのダッシュボード・LpProvider 経由で api を読む）
// バージョン一覧は静的カタログのままだが、ログ管理は api を叩くので composition 側で
// LpProvider に包む。タブは URL に紐づくので deep link / リロード / 戻る が成立する。
// auth:"required" なので未ログインはシェルが /login に戻す。
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { LpManagementScreen } from "./LpManagementScreen.tsx";
import { LpVisitLogScreen } from "./LpVisitLogScreen.tsx";

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
  { path: "/lp/visits", lazy: () => Promise.resolve({ Component: LpVisitLogScreen }), auth: "required" },
];

export const lpNav: LpNavEntry[] = [{ label: "LP管理", path: "/lp", icon: "megaphone" }];
