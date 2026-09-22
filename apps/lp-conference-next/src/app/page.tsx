import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";
import { Entrance } from "@/components/Entrance";
import { ScrollProgress } from "@/components/ScrollProgress";
import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { Catch } from "@/components/Catch";
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
// goodpatch-style rebuild — same content, elevated editorial composition:
//   sticky header → full-height hero → キャッチ → 01 とは？ → 02 プログラム(横)
//   → 03 クラウドファンディング → 04 応募 → 05 お問い合わせ → フッター。
const config = snapshot as LpConfig;

export default function Page() {
  return (
    <>
      <Entrance />
      <ScrollProgress />
      <Header nav={config.nav} cta={config.hero.primaryCta} />
      <Hero data={config.hero} />
      <Catch data={config.catch} />
      <About data={config.about} index="01" />
      <Program data={config.program} index="02" />
      <Crowdfunding data={config.crowdfunding} index="03" />
      <Apply data={config.apply} index="04" />
      <Contact data={config.contact} index="05" />
      <Footer data={config.footer} />
    </>
  );
}
