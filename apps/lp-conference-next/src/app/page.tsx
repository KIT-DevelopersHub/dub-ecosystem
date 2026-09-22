import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";
import { Entrance } from "@/components/Entrance";
import { MotionRoot } from "@/components/MotionRoot";
import { ScrollProgress } from "@/components/ScrollProgress";
import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { Apply } from "@/components/Apply";
import { Program } from "@/components/Program";
import { About } from "@/components/About";
import { Crowdfunding } from "@/components/Crowdfunding";
import { Vision } from "@/components/Vision";
import { Contact } from "@/components/Contact";
import { Footer } from "@/components/Footer";

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
const config = snapshot as LpConfig;
const siteUrl = config.footer.links[0]?.href;

export default function Page() {
  return (
    <>
      <Entrance />
      <MotionRoot />
      <ScrollProgress />
      <Header nav={config.nav} cta={config.hero.primaryCta} />
      <Hero data={config.hero} subheading={config.catch.lead} />
      <Apply data={config.apply} />
      <Program data={config.program} />
      <About data={config.about} />
      <Crowdfunding data={config.crowdfunding} />
      <Vision eyebrow="VISION" statement={config.catch.heading} />
      <Contact data={config.contact} siteUrl={siteUrl} />
      <Footer data={config.footer} nav={config.nav} />
    </>
  );
}
