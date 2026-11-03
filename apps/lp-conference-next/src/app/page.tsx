import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";
import { MotionRoot } from "@/components/MotionRoot";
import { ScrollProgress } from "@/components/ScrollProgress";
import { Hero } from "@/components/Hero";
import { Marquee } from "@/components/Marquee";
import { SectionSlot } from "@/sections/SectionSlot";

// Public conference LP — single page composed from the published snapshot
// (read-only at build time; never calls internal services live).
//
// This build reproduces goodpatch.com/ja's page SKELETON (section sequence,
// layout grammar, type scale, scroll choreography) with the conference's own
// text flowed in and entirely original brand visuals. goodpatch section →
// conference section mapping:
//   hero (centered statement + sub)         → Hero
//   dual service cards                       → Apply (参加者 / 登壇)
//   Featured Work (filter tabs + grid)       → Program (聴く/体験する/出会う)
//   3-col interview/activity cards           → About (とは？ 3点)
//   full-width special/callout band          → Crowdfunding (SUPPORT band)
//   Company Vision (big statement)           → Vision (キャッチ)
//   Get In Touch CTA band                    → Contact
//   multi-part footer                        → Footer
// (goodpatch's Design-Platforms carousel, Latest-Activities grid and Careers
//  are omitted — the conference has no matching content to flow in.)
//
// 公開設定（LP管理）で切り替えるセクションは SectionSlot で包む（sections/variants.tsx）。
// Hero と Marquee は登録簿に無いので常に出る。
const config = snapshot as LpConfig;
const siteUrl = config.footer.links[0]?.href;

export default function Page() {
  return (
    <>
      <MotionRoot />
      <ScrollProgress />
      <SectionSlot id="header" props={{ nav: config.nav, cta: config.hero.primaryCta, banner: config.crowdfunding.banner }} />
      <Hero data={config.hero} subheading={config.catch.lead} />
      <SectionSlot id="join" props={{ data: config.apply }} />
      <SectionSlot id="program" props={{ data: config.program }} />
      <Marquee sub={config.catch.lead} />
      <SectionSlot id="about" props={{ data: config.about }} />
      <SectionSlot id="crowdfunding" props={{ data: config.crowdfunding }} />
      <SectionSlot id="vision" props={{ eyebrow: "VISION", statement: config.catch.heading }} />
      <SectionSlot id="contact" props={{ data: config.contact, siteUrl }} />
      <SectionSlot id="footer" props={{ data: config.footer, nav: config.nav }} />
    </>
  );
}
