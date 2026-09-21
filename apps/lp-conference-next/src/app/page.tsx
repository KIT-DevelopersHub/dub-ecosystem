import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";
import { Entrance } from "@/components/Entrance";
import { ScrollProgress } from "@/components/ScrollProgress";
import { Opening } from "@/components/Opening";
import { StoryScene } from "@/components/StoryScene";
import { Closing } from "@/components/Closing";
import { About } from "@/components/About";
import { Program } from "@/components/Program";
import { Crowdfunding } from "@/components/Crowdfunding";
import { Apply } from "@/components/Apply";
import { Contact } from "@/components/Contact";
import { Footer } from "@/components/Footer";

// 北陸ITカンファレンス 公開LP v3 — 「握手」モチーフが貫通するスクロール物語。
// 物語順: OPENING → 作る → 守る → 導く → CLOSING(北陸から全国へ波及) を先に見せて
// 世界観を体験させ、その後に実務情報(とは？/プログラム/クラファン/応募/連絡先)を続ける。
//
// スナップショットはビルド時に READ-ONLY で読むだけ（内部サービスを叩かない・承認済み設計）。
const config = snapshot as LpConfig;

export default function Page() {
  return (
    <>
      <Entrance />
      <ScrollProgress />

      {/* --- 物語（感情） --- */}
      <Opening data={config.opening} nav={config.nav} />
      {config.story.map((scene, i) => (
        <StoryScene key={scene.id} scene={scene} index={i} />
      ))}
      <Closing data={config.closing} />

      {/* --- 実務情報 --- */}
      <About data={config.about} />
      <Program data={config.program} />
      <Crowdfunding data={config.crowdfunding} />
      <Apply data={config.apply} />
      <Contact data={config.contact} />
      <Footer data={config.footer} />
    </>
  );
}
