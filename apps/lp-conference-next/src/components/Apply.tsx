import Image from "next/image";
import { Reveal } from "@/components/Reveal";
import type { ApplyConfig } from "@/config/types";

// Apply (応募フォーム) — 対角 2×2: [参加者テキスト][参加者画像] / [登壇画像][登壇テキスト]。
// 画像には色オーバーレイと「〜こちら！」ラベルがモックアップ時点で焼き込まれているため、
// リンクの可視ラベルは画像側に任せ、a11y 用に aria-label を付ける。
// 画像=ボタンのホバー浮き上がり/ズームは pure CSS（globals.css）。
export function Apply({ data }: { data: ApplyConfig }) {
  const plabel = data.participant.cta.label.replace(/\n/g, "");
  const slabel = data.speaker.cta.label.replace(/\n/g, "");

  return (
    <section id="apply" className="section apply">
      <div className="container">
        <Reveal as="h2" className="section-title">
          {data.heading}
        </Reveal>
        <div className="apply-grid">
          <Reveal className="apply-text apply-cell--ptext">
            <p className="apply-title apply-title--participant">
              {data.participant.title}
              <span className="chev">≫</span>
            </p>
            <p className="apply-body">{data.participant.body}</p>
          </Reveal>

          <Reveal
            as="span"
            className="apply-cell--pimg"
            delay={0.08}
          >
            <a className="apply-card" href={data.participant.cta.href} aria-label={plabel}>
              <Image
                src="/img/apply-participant.png"
                alt={plabel}
                width={727}
                height={370}
                loading="lazy"
              />
            </a>
          </Reveal>

          <Reveal as="span" className="apply-cell--simg" delay={0.16}>
            <a className="apply-card" href={data.speaker.cta.href} aria-label={slabel}>
              <Image
                src="/img/apply-speaker.png"
                alt={slabel}
                width={740}
                height={374}
                loading="lazy"
              />
            </a>
          </Reveal>

          <Reveal className="apply-text apply-cell--stext" delay={0.24}>
            <p className="apply-title apply-title--speaker">
              <span className="chev">≪</span>
              {data.speaker.title}
            </p>
            <p className="apply-body">{data.speaker.body}</p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
