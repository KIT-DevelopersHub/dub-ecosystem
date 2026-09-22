// localStorage IO for the block editor. Keyed by an arbitrary caller-supplied
// string (an action id for the しおり panel, an event id for the event-page
// inline editor) so each surface's layout is independent. SSR/preview-safe (all
// access guarded). localStorage-first keeps the demo working with no backend
// round-trip; a real D1 persistence layer can replace loadDoc/saveDoc later
// without touching the editor components (next stage).
import {
  DEFAULT_SPAN_BY_TYPE,
  type Block,
  type BlockDoc,
  type BlockType,
  type ChecklistItem,
} from "./types";

const KEY_PREFIX = "dub.fe3.blockeditor.";

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function storageKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

export function loadDoc(key: string): BlockDoc | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BlockDoc;
    if (!parsed || !Array.isArray(parsed.blocks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when a saved doc with at least one block exists for this key. */
export function hasDoc(key: string): boolean {
  const doc = loadDoc(key);
  return !!doc && doc.blocks.length > 0;
}

export function saveDoc(key: string, doc: BlockDoc): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(key), JSON.stringify(doc));
  } catch {
    // Quota / disabled storage — non-fatal for a prototype.
  }
}

export function emptyDoc(): BlockDoc {
  return { version: 1, blocks: [], updatedAt: new Date().toISOString() };
}

/** Build a new block of the given type with sensible starter content. */
export function createBlock(type: BlockType): Block {
  const base = { id: uid(), span: DEFAULT_SPAN_BY_TYPE[type] };
  switch (type) {
    case "text":
      return { ...base, type, content: { text: "ここに説明やメモを書けます。" } };
    case "heading":
      return { ...base, type, content: { text: "見出し", level: 2 } };
    case "checklist":
      return {
        ...base,
        type,
        content: {
          items: [
            { id: uid(), label: "項目 A", checked: false },
            { id: uid(), label: "項目 B", checked: false },
          ] satisfies ChecklistItem[],
        },
      };
    case "image":
      return { ...base, type, content: { url: "", caption: "" } };
    case "calendar": {
      const d = new Date();
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      return { ...base, type, content: { month, events: [] } };
    }
    case "timetable":
      return {
        ...base,
        type,
        content: {
          slots: [{ id: uid(), time: "10:00", label: "受付開始", location: "" }],
        },
      };
    case "map":
      return { ...base, type, content: { query: "金沢駅", caption: "" } };
  }
}

/**
 * Seed a fresh event-page layout so an empty page opens with something
 * illustrative instead of a blank void when the organiser first hits "編集".
 * `title` / `description` mirror the structured event fields so the free layer
 * starts consistent with the data the page already shows.
 */
export function sampleEventDoc(title: string, description?: string): BlockDoc {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: uid(),
        type: "heading",
        span: 4,
        content: { text: title || "イベント", level: 1 },
      },
      {
        id: uid(),
        type: "text",
        span: 4,
        content: {
          text:
            description ||
            "このイベントページはブロックを自由に足して作れます。右のパレットからブロックを追加し、ドラッグで並べ替え、幅を変えられます。",
        },
      },
      {
        id: uid(),
        type: "timetable",
        span: 2,
        content: {
          slots: [
            { id: uid(), time: "09:30", label: "開場・受付", location: "1F ロビー" },
            { id: uid(), time: "10:00", label: "オープニング", location: "メインホール" },
            { id: uid(), time: "12:00", label: "ランチ交流会", location: "2F" },
          ],
        },
      },
      {
        id: uid(),
        type: "checklist",
        span: 2,
        content: {
          items: [
            { id: uid(), label: "受付の準備", checked: false },
            { id: uid(), label: "会場設営", checked: false },
            { id: uid(), label: "登壇資料の共有", checked: true },
          ],
        },
      },
      {
        id: uid(),
        type: "map",
        span: 4,
        content: { query: "金沢駅", caption: "会場アクセス" },
      },
    ],
  };
}
