// クライアント部品（Header）からも読むので、セクション部品を import しない小さなモジュールに分けている。
import type { LpSectionId } from "./registry";

/** ページ内アンカー（#apply など）→ セクション。非表示にしたセクションへのナビを隠すのに使う。 */
const ANCHOR_SECTION: Readonly<Record<string, LpSectionId>> = {
  "#apply": "join",
  "#program": "program",
  "#about": "about",
  "#crowdfunding": "crowdfunding",
  "#contact": "contact",
};

export function navSection(href: string): LpSectionId | undefined {
  return Object.prototype.hasOwnProperty.call(ANCHOR_SECTION, href) ? ANCHOR_SECTION[href] : undefined;
}
