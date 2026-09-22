import Image from "next/image";
import { Fragment } from "react";
import { Reveal } from "@/components/Reveal";
import type { ApplyConfig } from "@/config/types";

// Apply (応募フォーム) — 対角 2×2: [参加者テキスト][参加者ボタン] / [登壇ボタン][登壇テキスト]。
// ★ ボタンは画像ではなく「文字を含まない写真（純グラフィック）＋色スクリム＋実テキスト」。
//   ラベル (参加登録はこちら！/ 登壇への応募はこちら！) は HTML の実テキストで描画し、
//   選択・コピー・翻訳・SEO を可能にする。ホバーの浮き上がり/ズームは pure CSS。

// 改行入りラベルを実テキスト（<br/>）で描画。
function multiline(text: string) {
  const lines = text.split("\n");
  return lines.map((ln, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {ln}
    </Fragment>
  ));
}

export function Apply({ data, index }: { data: ApplyConfig; index?: string }) {
  const plabel = data.participant.cta.label.replace(/\n/g, "");
  const slabel = data.speaker.cta.label.replace(/\n/g, "");

  return (
    <section id="apply" className="section apply">
      <div className="container">
        <div className="section-head section-head--center">
          {index && (
            <Reveal as="span" className="section-index" variant="fade">
              {index}
            </Reveal>
          )}
          <Reveal as="h2" className="section-title" variant="up" delay={80}>
            {data.heading}
          </Reveal>
        </div>
        <div className="apply-grid">
          <Reveal className="apply-text apply-cell--ptext" variant="up">
            <p className="apply-title apply-title--participant">
              {data.participant.title}
              <span className="chev">≫</span>
            </p>
            <p className="apply-body">{data.participant.body}</p>
          </Reveal>

          <Reveal as="span" className="apply-cell--pimg" variant="up" delay={90}>
            <a
              className="apply-card apply-card--participant"
              href={data.participant.cta.href}
              aria-label={plabel}
            >
              <Image
                className="apply-card-img"
                src="/img/apply-participant.png"
                alt=""
                aria-hidden="true"
                width={727}
                height={370}
                loading="lazy"
              />
              <span className="apply-card-scrim" aria-hidden="true" />
              <span className="apply-card-label">
                {multiline(data.participant.cta.label)}
              </span>
            </a>
          </Reveal>

          <Reveal as="span" className="apply-cell--simg" variant="up" delay={180}>
            <a
              className="apply-card apply-card--speaker"
              href={data.speaker.cta.href}
              aria-label={slabel}
            >
              <Image
                className="apply-card-img"
                src="/img/apply-speaker.png"
                alt=""
                aria-hidden="true"
                width={740}
                height={374}
                loading="lazy"
              />
              <span className="apply-card-scrim" aria-hidden="true" />
              <span className="apply-card-label">
                {multiline(data.speaker.cta.label)}
              </span>
            </a>
          </Reveal>

          <Reveal className="apply-text apply-cell--stext" variant="up" delay={270}>
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
