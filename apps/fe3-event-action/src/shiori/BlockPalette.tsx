// Right-rail palette. Click a tile to append that block to the canvas. Mirrors
// the TabiBook palette (glyph icon + label + short description). Glyphs are plain
// characters/emoji so we stay off @dub/ui's closed IconName union.
import type { ShioriBlockType } from "./types";
import styles from "./shiori.module.css";

type Props = {
  onAdd: (type: ShioriBlockType) => void;
  disabled?: boolean;
};

type Entry = { type: ShioriBlockType; icon: string; label: string; desc: string };

const ENTRIES: Entry[] = [
  { type: "heading", icon: "H", label: "見出し", desc: "H1 / H2 / H3" },
  { type: "text", icon: "T", label: "テキスト", desc: "段落・メモ" },
  { type: "checklist", icon: "✓", label: "チェックリスト", desc: "持ち物・TODO" },
  { type: "timetable", icon: "\u{1F552}", label: "タイムテーブル", desc: "当日の進行" },
  { type: "calendar", icon: "\u{1F4C5}", label: "カレンダー", desc: "月表示 + 予定" },
  { type: "map", icon: "\u{1F5FA}", label: "マップ", desc: "Google Maps 埋込" },
  { type: "image", icon: "\u{1F5BC}", label: "画像", desc: "URL を貼る" },
];

export function BlockPalette({ onAdd, disabled }: Props) {
  return (
    <aside className={styles.palette} data-testid="fe3-shiori-palette">
      <header className={styles.paletteHeader}>
        <p className={styles.paletteEyebrow}>Palette</p>
        <h3 className={styles.paletteTitle}>ブロックを追加</h3>
      </header>
      <div className={styles.paletteBody}>
        {ENTRIES.map((e) => (
          <button
            key={e.type}
            type="button"
            className={styles.paletteTile}
            disabled={disabled}
            onClick={() => onAdd(e.type)}
            title="クリックで canvas に追加"
          >
            <span className={styles.paletteTileIcon} aria-hidden="true">
              {e.icon}
            </span>
            <span style={{ minWidth: 0 }}>
              <span className={styles.paletteTileLabel} style={{ display: "block" }}>
                {e.label}
              </span>
              <span className={styles.paletteTileDesc} style={{ display: "block" }}>
                {e.desc}
              </span>
            </span>
          </button>
        ))}
      </div>
      <footer className={styles.paletteFooter}>
        {disabled ? "閲覧モード（編集不可）" : "クリックで下に追加 → ドラッグで並べ替え"}
      </footer>
    </aside>
  );
}
