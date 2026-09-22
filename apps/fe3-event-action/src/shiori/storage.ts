// localStorage IO for the shiori editor. Keyed by action id so each event's
// booklet is independent. SSR/preview-safe (all access guarded). Mirrors the
// TabiBook prototype's localStorage-first approach — works in the mock demo
// without a backend round-trip.
import {
  DEFAULT_SPAN_BY_TYPE,
  type ChecklistItem,
  type ShioriBlock,
  type ShioriBlockType,
  type ShioriDoc,
} from "./types";

const KEY_PREFIX = "dub.fe3.shiori.";

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function storageKey(actionId: string): string {
  return `${KEY_PREFIX}${actionId}`;
}

export function loadDoc(actionId: string): ShioriDoc | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(actionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ShioriDoc;
    if (!parsed || !Array.isArray(parsed.blocks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDoc(actionId: string, doc: ShioriDoc): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(actionId), JSON.stringify(doc));
  } catch {
    // Quota / disabled storage — non-fatal for a prototype.
  }
}

export function emptyDoc(): ShioriDoc {
  return { version: 1, blocks: [], updatedAt: new Date().toISOString() };
}

/** Build a new block of the given type with sensible starter content. */
export function createBlock(type: ShioriBlockType): ShioriBlock {
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
            { id: uid(), label: "持ち物 A", checked: false },
            { id: uid(), label: "持ち物 B", checked: false },
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

/** Seed a fresh booklet so an empty action opens with something illustrative. */
export function sampleDoc(eventTitle: string): ShioriDoc {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: uid(),
        type: "heading",
        span: 4,
        content: { text: `${eventTitle} しおり`, level: 1 },
      },
      {
        id: uid(),
        type: "text",
        span: 4,
        content: {
          text: "このページはブロックを自由に足して作る「イベントのしおり」です。右のパレットからブロックを追加し、ドラッグで並べ替え、幅を変えられます。",
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
            { id: uid(), label: "名札", checked: false },
            { id: uid(), label: "ノートPC", checked: false },
            { id: uid(), label: "モバイルバッテリー", checked: true },
          ],
        },
      },
      {
        id: uid(),
        type: "map",
        span: 4,
        content: { query: "金沢駅", caption: "集合場所" },
      },
    ],
  };
}
