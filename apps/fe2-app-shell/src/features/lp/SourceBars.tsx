// 流入元別の内訳（純 CSS 横棒）。チャートライブラリは一切追加しない（バンドルを太らせない）。
// 色だけで意味を運ばないよう、各行は「流入元名 + 棒 + 件数(構成比)」を必ずテキストで併記する。
import { barPercent, formatCount, sharePercent, sourceLabel } from "./lpRange.ts";
import type { LpStatsBucket } from "./lpApi.tsx";
import styles from "./lp.module.css";

export function SourceBars({ buckets }: { buckets: LpStatsBucket[] }): JSX.Element {
  // 多い順に並べる（呼び出し側の順序に依存しない）。
  const rows = buckets.slice().sort((a, b) => b.visits - a.visits);
  const max = rows.reduce((m, b) => Math.max(m, b.visits), 0);
  const total = rows.reduce((s, b) => s + b.visits, 0);

  return (
    <div className={styles.bars} data-testid="fe2-lp-source-bars">
      {rows.map((b) => {
        const label = b.label || sourceLabel(b.key);
        const pct = barPercent(b.visits, max);
        const share = sharePercent(b.visits, total);
        return (
          <div key={b.key} className={styles.barRow} data-testid={`fe2-lp-source-bar-${b.key}`}>
            <span className={styles.barLabel}>{label}</span>
            {/* 棒は装飾。数値は右の列がテキストで持つので aria-hidden にはせず role=img + label で読ませる。 */}
            <div className={styles.barTrack} role="img" aria-label={`${label} ${formatCount(b.visits)}件`}>
              <div className={styles.barFill} style={{ width: `${pct}%` }} />
            </div>
            <span className={styles.barValue}>
              {formatCount(b.visits)}件 <span className={styles.barShare}>({share}%)</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
