// 企業 = 名刺の会社名でまとめたもの (DB に企業テーブルは持たない)。
// 「株式会社」「(株)」・全角/半角・空白の違いは同じ企業として扱い、入力時は既存の企業名を候補に出して表記を揃える。
import type { sponsor } from "@dub/types";

const LEGAL_FORMS =
  /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|npo法人|\((株|有|同|資|名|社|財)\)/g;

/** 会社名の照合キー。法人格・空白・記号を除いた NFKC 小文字。 */
export function companyKey(name: string): string {
  const base = name.normalize("NFKC").toLowerCase();
  const key = base.replace(LEGAL_FORMS, "").replace(/[\s・.,、。'"]/g, "");
  return key === "" ? base.trim() : key;
}

export interface Company {
  key: string;
  /** 表示名 = いちばん多く使われている表記 (同数なら新しい名刺の表記)。 */
  name: string;
  /** 新しい順。 */
  cards: sponsor.BusinessCard[];
  /** 名刺を登録したメンバー (重複なし・新しい順)。 */
  members: string[];
  lastAt: string;
}

/** 名刺を企業ごとにまとめる。会社名が空の名刺は含めない (件数は unassigned で返す)。 */
export function groupCompanies(cards: readonly sponsor.BusinessCard[]): { companies: Company[]; unassigned: number } {
  const byKey = new Map<string, sponsor.BusinessCard[]>();
  let unassigned = 0;
  for (const c of cards) {
    const name = c.companyName?.trim();
    if (!name) {
      unassigned += 1;
      continue;
    }
    const k = companyKey(name);
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  const companies = [...byKey].map(([key, list]): Company => {
    const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const counts = new Map<string, number>();
    for (const c of sorted) counts.set(c.companyName!.trim(), (counts.get(c.companyName!.trim()) ?? 0) + 1);
    // sorted は新しい順なので、同数なら先に出た (新しい) 表記が勝つ。
    let name = "";
    let best = 0;
    for (const [n, count] of counts) {
      if (count > best) {
        name = n;
        best = count;
      }
    }
    const members = [...new Set(sorted.map((c) => c.createdByName).filter((n): n is string => !!n))];
    return { key, name, cards: sorted, members, lastAt: sorted[0]!.createdAt };
  });
  companies.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return { companies, unassigned };
}

/** 入力中の会社名に近い既存の企業名 (表記が完全に同じものは除く)。 */
export function suggestCompanies(input: string, names: readonly string[], limit = 3): string[] {
  const q = input.trim();
  if (q === "") return [];
  const k = companyKey(q);
  return names.filter((n) => n !== q && companyKey(n).includes(k)).slice(0, limit);
}
