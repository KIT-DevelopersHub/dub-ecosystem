// 「支援者情報」パターンのデータ整形（純粋関数・node --test で検証）。
import type { CrowdfundingSupporters, SupporterTier } from "@/config/types";

export interface SupporterGroup {
  label: string;
  /** framed = 金・銀の枠付きカード / list = ◆ の一覧 */
  kind: "framed" | "list";
  tiers: SupporterTier[];
}

const OTHER_LABEL = "ご支援者様";

/** 旧形式（names[]）も tiers に寄せ、空の段を落とす。 */
export function supporterTiers(data: CrowdfundingSupporters): SupporterTier[] {
  const tiers: SupporterTier[] =
    data.tiers ?? (data.names?.length ? [{ id: "other", label: OTHER_LABEL, items: data.names.map((name) => ({ name })) }] : []);
  return tiers
    .map((t) => ({ ...t, items: t.items.filter((i) => i.name.trim() !== "") }))
    .filter((t) => t.items.length > 0);
}

/** 続く段が同じ見出し・同じ見せ方なら 1 つの小見出しにまとめる。 */
export function supporterGroups(data: CrowdfundingSupporters): SupporterGroup[] {
  const groups: SupporterGroup[] = [];
  for (const tier of supporterTiers(data)) {
    const kind = tier.id === "other" ? "list" : "framed";
    const last = groups[groups.length - 1];
    if (last && last.label === tier.label && last.kind === kind) last.tiers.push(tier);
    else groups.push({ label: tier.label, kind, tiers: [tier] });
  }
  return groups;
}
