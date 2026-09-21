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

// --- v3 narrative (握手モチーフの物語) ---

export interface OpeningConfig {
  eyebrow: string;
  titleJp: string;
  titleIt: string;
  titleTail: string;
  subtitle: string;
  /** 改行可（\n）。 */
  tagline: string;
  body: string;
  dateLabel: string;
  venueLabel: string;
  primaryCta?: CtaLink;
  secondaryCta?: CtaLink;
}

export type SceneVariant = "create" | "protect" | "lead";

export interface StoryScene {
  id: string;
  variant: SceneVariant;
  /** 例: "01 — 作る" */
  kicker: string;
  title: string;
  lead: string;
  points: string[];
  /** さりげない地元要素の一言。 */
  local?: string;
}

export interface ClosingConfig {
  kicker: string;
  title: string;
  lead: string;
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

export interface CrowdfundingConfig {
  heading: string;
  body: string;
  cta?: CtaLink;
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
  opening: OpeningConfig;
  story: StoryScene[];
  closing: ClosingConfig;
  hero: HeroConfig;
  catch: CatchConfig;
  about: AboutConfig;
  program: ProgramConfig;
  crowdfunding: CrowdfundingConfig;
  apply: ApplyConfig;
  contact: ContactConfig;
  footer: FooterConfig;
}
