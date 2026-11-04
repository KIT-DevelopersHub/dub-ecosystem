// LP管理 FeatureModule source (mail/usage と同じく FE2 ローカル feature)。
// composition (featureModules.tsx) が nav の順序を束ね、withAppAccessGate が
// app:lp:view を各ルート/タイルに AND する（実際の per-app ゲート）。ルートは 3 つ:
//   /lp        → 公開設定（?env=draft|live。下書きで確かめて本番へ反映・版の一覧は Drawer）
//   /lp/preview → 旧プレビュータブ。/lp?env=draft へリダイレクト
//   /lp/links  → 流入URL（計測つき URL の発行と流入元別の実績・api を読む/書く）
//   /lp/visits → ログ管理（流入ログのダッシュボード・LpProvider 経由で api を読む）
//   /lp/tickets → チケット（LP の /tickets 購入ページの販売設定・券種・入力項目・購入者）
//   /lp/proposals → 登壇者募集（LP の /proposals 応募ページの公開・入力項目・応募の選考）
// バージョン一覧は静的カタログのままだが、流入URL/ログ管理は api を叩くので composition 側で
// LpProvider に包む。タブは URL に紐づくので deep link / リロード / 戻る が成立する。
// auth:"required" なので未ログインはシェルが /login に戻す。
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { LpSiteConfigScreen } from "./LpSiteConfigScreen.tsx";
import { LpLinksScreen } from "./LpLinksScreen.tsx";
import { LpPreviewScreen } from "./LpPreviewScreen.tsx";
import { LpVisitLogScreen } from "./LpVisitLogScreen.tsx";
import { LpTicketsScreen } from "./LpTicketsScreen.tsx";
import { LpProposalsScreen } from "./LpProposalsScreen.tsx";

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
  { path: "/lp", lazy: () => Promise.resolve({ Component: LpSiteConfigScreen }), auth: "required" },
  { path: "/lp/preview", lazy: () => Promise.resolve({ Component: LpPreviewScreen }), auth: "required" },
  { path: "/lp/links", lazy: () => Promise.resolve({ Component: LpLinksScreen }), auth: "required" },
  { path: "/lp/visits", lazy: () => Promise.resolve({ Component: LpVisitLogScreen }), auth: "required" },
  { path: "/lp/tickets", lazy: () => Promise.resolve({ Component: LpTicketsScreen }), auth: "required" },
  { path: "/lp/proposals", lazy: () => Promise.resolve({ Component: LpProposalsScreen }), auth: "required" },
];

export const lpNav: LpNavEntry[] = [{ label: "LP管理", path: "/lp", icon: "megaphone" }];
