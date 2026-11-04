// スポンサー FeatureModule source (人事と同じく FE2 ローカル feature)。composition が SponsorProvider で
// 包み、withAppAccessGate が app:sponsor:view を各ルート/タイルに AND する (実際の per-app ゲート)。
// 未公開アプリ (releaseGate PUBLISHED_APPS 外) なので admin 以外はランチャーでグレー表示。
//   /sponsor      → 名刺一覧 (検索・詳細ドロワーで編集/写真の撮り直し/削除)
//   /sponsor/scan → 名刺をスキャン (撮影 → 入力 → 保存)
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { SponsorCardsScreen } from "./SponsorCardsScreen.tsx";
import { SponsorScanScreen } from "./SponsorScanScreen.tsx";

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
  { path: "/sponsor/scan", lazy: () => Promise.resolve({ Component: SponsorScanScreen }), auth: "required" },
];

export const sponsorNav: SponsorNavEntry[] = [{ label: "スポンサー", path: "/sponsor", icon: "folder" }];
