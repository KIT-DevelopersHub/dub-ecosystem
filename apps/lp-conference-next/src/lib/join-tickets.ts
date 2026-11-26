// JOIN の参加者カードをチケット販売の設定（LP管理 > チケット の「販売」「参加登録ボタンを差し替え」）で切り替える。
// LP は静的書き出しなので、カードは「準備中」と「購入リンク」の両方を描き、Worker が <html> に付ける属性で
// CSS が片方だけ見せる（JS オフでも効き、hydration とも衝突しない）。
export const JOIN_TICKETS_ATTR = "data-lp-join-tickets";
export const JOIN_TICKETS_HREF = "/tickets";
export const JOIN_TICKETS_LABEL = "参加チケットを購入";

/** 販売 on かつ CTA 差し替え on のときだけ属性を付ける（既存の差し替え script と同じ条件）。 */
export function joinTicketsAttributes(cfg: { enabled: boolean; ctaEnabled: boolean } | null): Record<string, string> {
  return cfg && cfg.enabled && cfg.ctaEnabled ? { [JOIN_TICKETS_ATTR]: "on" } : {};
}
