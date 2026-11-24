// 公開設定の中身で埋めるセクション（協力団体ロゴ・お知らせ・登壇者情報・スポンサー）の枠。
// 項目は LP Worker が [data-lp-content] に差し込む（worker/lp-content.ts）。ここは見出しと空の入れ物だけ。
// 入れ物は dangerouslySetInnerHTML にしておく: hydrate のとき React が差し込まれた中身を消さない。
// 既定は非表示（登録簿の defaultVisible: false）なので、Worker を通らない表示では枠ごと出ない。
import type { LpContentSectionId } from "@/sections/registry";
import "./content-sections.css";

/** 枠は props を取らない（SectionSlot に渡す props の形をそろえるための型）。 */
type ShellProps = Record<string, never>;

function Slot({ id, className }: { id: LpContentSectionId; className: string }) {
  return <div className={className} data-lp-content={id} dangerouslySetInnerHTML={{ __html: "" }} />;
}

function Head({ eyebrow, title, id }: { eyebrow: string; title: string; id: string }) {
  return (
    <div className="lp-xhead">
      <span className="lp-xhead-eyebrow" aria-hidden="true">
        -{eyebrow}
      </span>
      <h2 className="lp-xhead-title" id={id}>
        {title}
      </h2>
    </div>
  );
}

export function Partners(_props: ShellProps) {
  return (
    <section id="partners" className="lp-partners" aria-labelledby="partners-title">
      <h2 className="lp-partners-title" id="partners-title">
        協力団体
      </h2>
      <Slot id="partners" className="lp-partners-body" />
    </section>
  );
}

export function News(_props: ShellProps) {
  return (
    <section id="news" className="lp-news" aria-labelledby="news-title">
      <span className="lp-sparkle lp-sparkle--a" aria-hidden="true" />
      <span className="lp-sparkle lp-sparkle--b" aria-hidden="true" />
      <div className="container lp-news-inner">
        <span className="lp-xhead-eyebrow lp-news-eyebrow" aria-hidden="true">
          -news
        </span>
        <div className="lp-news-card">
          <h2 className="lp-news-title" id="news-title">
            お知らせ
          </h2>
          <Slot id="news" className="lp-news-body" />
        </div>
      </div>
    </section>
  );
}

export function Speakers(_props: ShellProps) {
  return (
    <section id="speakers" className="lp-dark lp-speakers" aria-labelledby="speakers-title">
      <div className="container">
        <Head eyebrow="speakers" title="登壇者情報" id="speakers-title" />
        <Slot id="speakers" className="lp-speakers-body" />
      </div>
    </section>
  );
}

export function Sponsors(_props: ShellProps) {
  return (
    <section id="sponsors" className="lp-dark lp-sponsors" aria-labelledby="sponsors-title">
      <div className="container">
        <Head eyebrow="sponsors" title="スポンサー" id="sponsors-title" />
        <Slot id="sponsors" className="lp-sponsors-body" />
      </div>
    </section>
  );
}
