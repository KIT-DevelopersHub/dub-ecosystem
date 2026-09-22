// Per-type block renderers. Each renders a read/view mode and, when `editing`
// (double-click on the card, write permission), inline editors. Content changes
// bubble up via `onChange(nextBlock)`.
import { useMemo } from "react";
import { uid } from "./storage";
import type {
  CalendarBlock,
  ChecklistBlock,
  HeadingBlock,
  ImageBlock,
  MapBlock,
  ShioriBlock,
  TextBlock,
  TimetableBlock,
} from "./types";
import styles from "./shiori.module.css";

type BlockProps<T extends ShioriBlock> = {
  block: T;
  editing: boolean;
  onChange: (next: T) => void;
};

export function BlockContent({
  block,
  editing,
  onChange,
}: {
  block: ShioriBlock;
  editing: boolean;
  onChange: (next: ShioriBlock) => void;
}) {
  switch (block.type) {
    case "text":
      return <TextBlockView block={block} editing={editing} onChange={onChange} />;
    case "heading":
      return <HeadingBlockView block={block} editing={editing} onChange={onChange} />;
    case "checklist":
      return <ChecklistBlockView block={block} editing={editing} onChange={onChange} />;
    case "image":
      return <ImageBlockView block={block} editing={editing} onChange={onChange} />;
    case "calendar":
      return <CalendarBlockView block={block} editing={editing} onChange={onChange} />;
    case "timetable":
      return <TimetableBlockView block={block} editing={editing} onChange={onChange} />;
    case "map":
      return <MapBlockView block={block} editing={editing} onChange={onChange} />;
  }
}

function TextBlockView({ block, editing, onChange }: BlockProps<TextBlock>) {
  if (editing) {
    return (
      <textarea
        className={`${styles.field} ${styles.textarea}`}
        value={block.content.text}
        autoFocus
        onChange={(e) => onChange({ ...block, content: { text: e.target.value } })}
        placeholder="本文を入力…"
      />
    );
  }
  return <p className={styles.blockText}>{block.content.text || "（テキスト未入力）"}</p>;
}

function HeadingBlockView({ block, editing, onChange }: BlockProps<HeadingBlock>) {
  const cls = block.content.level === 1 ? styles.h1 : block.content.level === 2 ? styles.h2 : styles.h3;
  if (editing) {
    return (
      <div className={styles.rowGap}>
        <input
          className={styles.field}
          value={block.content.text}
          autoFocus
          onChange={(e) => onChange({ ...block, content: { ...block.content, text: e.target.value } })}
          placeholder="見出し"
        />
        <div className={styles.inlineRow}>
          {[1, 2, 3].map((lv) => (
            <button
              key={lv}
              type="button"
              className={styles.miniBtn}
              style={block.content.level === lv ? { borderColor: "var(--dub-color-border-focus)" } : undefined}
              onClick={() => onChange({ ...block, content: { ...block.content, level: lv as 1 | 2 | 3 } })}
            >
              H{lv}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return <div className={cls}>{block.content.text || "見出し"}</div>;
}

function ChecklistBlockView({ block, editing, onChange }: BlockProps<ChecklistBlock>) {
  const { items } = block.content;
  const setItems = (next: typeof items) => onChange({ ...block, content: { items: next } });
  return (
    <div className={styles.rowGap}>
      {items.map((it) => (
        <div key={it.id} className={styles.checkItem}>
          <input
            type="checkbox"
            checked={it.checked}
            onChange={(e) => setItems(items.map((x) => (x.id === it.id ? { ...x, checked: e.target.checked } : x)))}
          />
          {editing ? (
            <>
              <input
                className={styles.field}
                value={it.label}
                onChange={(e) => setItems(items.map((x) => (x.id === it.id ? { ...x, label: e.target.value } : x)))}
              />
              <button
                type="button"
                className={styles.miniBtn}
                aria-label="項目を削除"
                onClick={() => setItems(items.filter((x) => x.id !== it.id))}
              >
                ×
              </button>
            </>
          ) : (
            <span className={it.checked ? styles.checkLabelDone : undefined}>{it.label}</span>
          )}
        </div>
      ))}
      {editing && (
        <button
          type="button"
          className={styles.miniBtn}
          onClick={() => setItems([...items, { id: uid(), label: "新しい項目", checked: false }])}
        >
          + 項目を追加
        </button>
      )}
    </div>
  );
}

function ImageBlockView({ block, editing, onChange }: BlockProps<ImageBlock>) {
  const { url, caption } = block.content;
  if (editing) {
    return (
      <div className={styles.rowGap}>
        <input
          className={styles.field}
          value={url}
          autoFocus
          onChange={(e) => onChange({ ...block, content: { ...block.content, url: e.target.value } })}
          placeholder="画像 URL (https://…)"
        />
        <input
          className={styles.field}
          value={caption ?? ""}
          onChange={(e) => onChange({ ...block, content: { ...block.content, caption: e.target.value } })}
          placeholder="キャプション（任意）"
        />
      </div>
    );
  }
  return (
    <figure style={{ margin: 0 }}>
      {url ? (
        <img className={styles.img} src={url} alt={block.content.alt ?? caption ?? ""} />
      ) : (
        <div className={styles.imgFallback}>画像 URL を設定してください</div>
      )}
      {caption ? <figcaption className={styles.caption}>{caption}</figcaption> : null}
    </figure>
  );
}

function TimetableBlockView({ block, editing, onChange }: BlockProps<TimetableBlock>) {
  const { slots } = block.content;
  const setSlots = (next: typeof slots) => onChange({ ...block, content: { ...block.content, slots: next } });
  const sorted = useMemo(() => [...slots].sort((a, b) => a.time.localeCompare(b.time)), [slots]);
  if (editing) {
    return (
      <div className={styles.rowGap}>
        {slots.map((s) => (
          <div key={s.id} className={styles.inlineRow}>
            <input
              className={styles.field}
              style={{ maxWidth: 90 }}
              value={s.time}
              onChange={(e) => setSlots(slots.map((x) => (x.id === s.id ? { ...x, time: e.target.value } : x)))}
              placeholder="10:00"
            />
            <input
              className={styles.field}
              value={s.label}
              onChange={(e) => setSlots(slots.map((x) => (x.id === s.id ? { ...x, label: e.target.value } : x)))}
              placeholder="内容"
            />
            <button
              type="button"
              className={styles.miniBtn}
              aria-label="行を削除"
              onClick={() => setSlots(slots.filter((x) => x.id !== s.id))}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className={styles.miniBtn}
          onClick={() => setSlots([...slots, { id: uid(), time: "", label: "", location: "" }])}
        >
          + 行を追加
        </button>
      </div>
    );
  }
  return (
    <table className={styles.tt}>
      <tbody>
        {sorted.map((s) => (
          <tr key={s.id}>
            <td className={styles.ttTime}>{s.time}</td>
            <td>
              {s.label}
              {s.location ? <div className={styles.ttLoc}>{s.location}</div> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MapBlockView({ block, editing, onChange }: BlockProps<MapBlock>) {
  const { query, caption } = block.content;
  if (editing) {
    return (
      <div className={styles.rowGap}>
        <input
          className={styles.field}
          value={query}
          autoFocus
          onChange={(e) => onChange({ ...block, content: { ...block.content, query: e.target.value } })}
          placeholder="地名・住所（例: 金沢駅）"
        />
        <input
          className={styles.field}
          value={caption ?? ""}
          onChange={(e) => onChange({ ...block, content: { ...block.content, caption: e.target.value } })}
          placeholder="キャプション（任意）"
        />
      </div>
    );
  }
  const src = `https://www.google.com/maps?q=${encodeURIComponent(query || "金沢駅")}&output=embed`;
  return (
    <div>
      <iframe className={styles.mapFrame} src={src} title={`地図: ${query}`} loading="lazy" />
      {caption ? <div className={styles.caption}>{caption}</div> : null}
    </div>
  );
}

function CalendarBlockView({ block, editing, onChange }: BlockProps<CalendarBlock>) {
  const { month, events } = block.content;
  const [year, mon] = month.split("-").map((n) => Number(n));
  const grid = useMemo(() => buildMonthGrid(year || 2026, (mon || 1) - 1), [year, mon]);
  const byDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of events) {
      const arr = m.get(e.date) ?? [];
      arr.push(e.label);
      m.set(e.date, arr);
    }
    return m;
  }, [events]);
  const setEvents = (next: typeof events) => onChange({ ...block, content: { ...block.content, events: next } });

  return (
    <div className={styles.rowGap}>
      {editing && (
        <div className={styles.inlineRow}>
          <input
            className={styles.field}
            style={{ maxWidth: 120 }}
            value={month}
            onChange={(e) => onChange({ ...block, content: { ...block.content, month: e.target.value } })}
            placeholder="YYYY-MM"
          />
        </div>
      )}
      <div className={styles.cal}>
        {["日", "月", "火", "水", "木", "金", "土"].map((d) => (
          <div key={d} className={styles.calHead}>
            {d}
          </div>
        ))}
        {grid.map((cell, i) => (
          <div key={i} className={`${styles.calCell} ${cell.inMonth ? "" : styles.calCellMuted}`}>
            {cell.inMonth ? cell.day : ""}
            {cell.inMonth &&
              (byDay.get(cell.iso) ?? []).map((label, k) => (
                <div key={k} className={styles.calDot} title={label}>
                  {label}
                </div>
              ))}
          </div>
        ))}
      </div>
      {editing && (
        <div className={styles.rowGap}>
          {events.map((e) => (
            <div key={e.id} className={styles.inlineRow}>
              <input
                className={styles.field}
                style={{ maxWidth: 140 }}
                value={e.date}
                onChange={(ev) => setEvents(events.map((x) => (x.id === e.id ? { ...x, date: ev.target.value } : x)))}
                placeholder="YYYY-MM-DD"
              />
              <input
                className={styles.field}
                value={e.label}
                onChange={(ev) => setEvents(events.map((x) => (x.id === e.id ? { ...x, label: ev.target.value } : x)))}
                placeholder="予定"
              />
              <button
                type="button"
                className={styles.miniBtn}
                aria-label="予定を削除"
                onClick={() => setEvents(events.filter((x) => x.id !== e.id))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.miniBtn}
            onClick={() => setEvents([...events, { id: uid(), date: `${month}-01`, label: "予定" }])}
          >
            + 予定を追加
          </button>
        </div>
      )}
    </div>
  );
}

function buildMonthGrid(year: number, monthIndex: number): { day: number; inMonth: boolean; iso: string }[] {
  const first = new Date(year, monthIndex, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: { day: number; inMonth: boolean; iso: string }[] = [];
  for (let i = 0; i < startDow; i++) cells.push({ day: 0, inMonth: false, iso: "" });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ day: d, inMonth: true, iso });
  }
  while (cells.length % 7 !== 0) cells.push({ day: 0, inMonth: false, iso: "" });
  return cells;
}
