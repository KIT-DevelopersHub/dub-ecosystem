// Types for the read-only publish snapshot the LP renders. Mirrors the shape of
// src/config/snapshot.json. The LP consumes the snapshot statically at build
// time and never talks to internal services live.

export interface CtaLink {
  label: string;
  href: string;
}

export interface NavLink {
  label: string;
  href: string;
}

export interface SeoConfig {
  title: string;
  description: string;
  siteUrl: string;
  ogImage: string;
}

export interface HeroConfig {
  heading: string;
  dateLabel: string;
  venueLabel: string;
  primaryCta?: CtaLink;
  secondaryCta?: CtaLink;
}

export interface CatchConfig {
  lead: string;
  heading: string;
}

export interface AboutConfig {
  heading: string;
  body: string[];
}

export interface ProgramItem {
  photo?: string;
  name?: string;
  note?: string;
}

export interface ProgramConfig {
  heading: string;
  note: string;
  items: ProgramItem[];
}

/** Top-of-page "now running" ribbon. Remove from the snapshot to hide it. */
export interface CrowdfundingBanner {
  text: string;
  /** Narrow-screen variant of `text`. */
  shortText?: string;
  ctaLabel: string;
  href: string;
}

/** 支援者 1 名（掲載を希望された方のみ）。name は敬称抜き（表示で「様」を付ける）。 */
export interface SupporterItem {
  name: string;
  /** 一言メッセージ（任意）。 */
  message?: string;
}

/** 支援の段。gold / silver は枠付きカード、other は ◆ の一覧。 */
export type SupporterTierId = "gold" | "silver" | "other";

export interface SupporterTier {
  id: SupporterTierId;
  /** 小見出し。続く段が同じ見出しなら 1 つにまとめる（gold と silver で同じ見出しを使う）。 */
  label: string;
  items: SupporterItem[];
}

/** クラファン情報の「支援者情報」パターン（LP管理の公開設定で切り替え）。 */
export interface CrowdfundingSupporters {
  /** 見出しの上の英字（既定 SPECIAL THANKS）。 */
  eyebrow?: string;
  heading: string;
  /** 見出し下のリード文。無ければ body を使う（旧形式）。 */
  lead?: string;
  /** 旧形式のリード文。 */
  body?: string;
  /** 段ごとの支援者。全段が空なら emptyNote を出す。 */
  tiers?: SupporterTier[];
  /** 旧形式: お名前だけの一覧。tiers が無いときは other 段として出す。 */
  names?: string[];
  emptyNote: string;
}

export interface CrowdfundingConfig {
  heading: string;
  body: string;
  cta?: CtaLink;
  banner?: CrowdfundingBanner;
  supporters?: CrowdfundingSupporters;
}

export interface ApplySide {
  title: string;
  body: string;
  cta: CtaLink;
}

export interface ApplyConfig {
  heading: string;
  participant: ApplySide;
  speaker: ApplySide;
}

export interface ContactConfig {
  heading: string;
  org: string;
  email: string;
  note: string;
}

export interface FooterConfig {
  org: string;
  links: NavLink[];
  copyright: string;
}

export interface LpConfig {
  version: number;
  publishedAt: string;
  seo: SeoConfig;
  nav: NavLink[];
  hero: HeroConfig;
  catch: CatchConfig;
  about: AboutConfig;
  program: ProgramConfig;
  crowdfunding: CrowdfundingConfig;
  apply: ApplyConfig;
  contact: ContactConfig;
  footer: FooterConfig;
}
