// スポンサー FeatureModule source (人事と同じく FE2 ローカル feature)。composition が SponsorProvider で
// 包み、withAppAccessGate が app:sponsor:view を各ルート/タイルに AND する (実際の per-app ゲート)。
// 未公開アプリ (releaseGate PUBLISHED_APPS 外) なので admin 以外はランチャーでグレー表示。
//   /sponsor      → 名刺 (名簿形式の表・検索・詳細ドロワーで編集/写真の撮り直し/削除)
//   /sponsor/companies → 企業 (名刺を会社名でまとめた表)
//   /sponsor/leads → 営業 (声をかけた企業ごとの進捗の表・集計・貼り付けで取り込み)
//   /sponsor/scan → 名刺をスキャン (撮影 → 入力 → 保存)
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { SponsorCardsScreen } from "./SponsorCardsScreen.tsx";
import { SponsorScanScreen } from "./SponsorScanScreen.tsx";
import { SponsorCompaniesScreen } from "./SponsorCompaniesScreen.tsx";
import { SponsorLeadsScreen } from "./SponsorLeadsScreen.tsx";

export interface SponsorSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
}
export interface SponsorNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const sponsorRoutes: SponsorSourceRoute[] = [
  { path: "/sponsor", lazy: () => Promise.resolve({ Component: SponsorCardsScreen }), auth: "required" },
  { path: "/sponsor/companies", lazy: () => Promise.resolve({ Component: SponsorCompaniesScreen }), auth: "required" },
  { path: "/sponsor/leads", lazy: () => Promise.resolve({ Component: SponsorLeadsScreen }), auth: "required" },
  { path: "/sponsor/scan", lazy: () => Promise.resolve({ Component: SponsorScanScreen }), auth: "required" },
];

export const sponsorNav: SponsorNavEntry[] = [{ label: "スポンサー", path: "/sponsor", icon: "folder" }];
