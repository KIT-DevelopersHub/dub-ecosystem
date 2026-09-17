import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";
import { Entrance } from "@/components/Entrance";
import { Hero } from "@/components/Hero";
import { Catch } from "@/components/Catch";
import { Stats, type StatItem } from "@/components/Stats";
import { About } from "@/components/About";
import { Program } from "@/components/Program";
import { Crowdfunding } from "@/components/Crowdfunding";
import { Apply } from "@/components/Apply";
import { Contact } from "@/components/Contact";
import { Footer } from "@/components/Footer";

// Public conference LP — single page composed from the published snapshot.
// The page reads the snapshot READ-ONLY at build time; it never calls internal
// services / admin APIs live (承認済み設計の核).
//
// セクション順は構成案（全体モックアップ）に準拠:
//   TOP(hero) → キャッチ帯 → 数字バンド → とは？ → プログラム内容(横スクロール)
//   → クラウドファンディング → 応募フォーム → お問い合わせ → フッター。
const config = snapshot as LpConfig;

// Factual figures for the count-up band, derived from the snapshot only
// (no fabricated attendance numbers): 開催年 / 開催日数 / プログラムの柱数。
const stats: StatItem[] = [
  { value: 2027, label: "開催年" },
  { value: config.hero.dateLabel.split("・").length, suffix: "日間", label: "開催" },
  { value: config.program.items.length, suffix: "つ", label: "体験のかたち" },
];

export default function Page() {
  return (
    <>
      <Entrance />
      <Hero data={config.hero} nav={config.nav} />
      <Catch data={config.catch} />
      <Stats items={stats} />
      <About data={config.about} />
      <Program data={config.program} />
      <Crowdfunding data={config.crowdfunding} />
      <Apply data={config.apply} />
      <Contact data={config.contact} />
      <Footer data={config.footer} />
    </>
  );
}
