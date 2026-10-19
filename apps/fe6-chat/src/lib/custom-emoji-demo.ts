// Backend-free custom emoji simulator for the standalone mock (MockChatClient) and the fe2
// VITE_DEMO transport. Mirrors chat-service's semantics (src/custom-emoji.ts): a name cursor,
// bounded batches, already-registered names skipped, aliases land once their target exists,
// aliases of standard emoji are skipped. Images are small inline SVGs built here (no external
// image is ever linked); "partyparrot" animates to stand in for a Slack GIF.
import type { CustomEmoji, EmojiImportResult } from "../api/contract";

interface DemoImage {
  name: string;
  svg: string;
}

function badge(text: string, bg: string, fg = "#ffffff", size = 26): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<rect x="2" y="2" width="60" height="60" rx="14" fill="${bg}"/>` +
    `<text x="32" y="33" font-family="system-ui, sans-serif" font-size="${size}" font-weight="700" fill="${fg}" text-anchor="middle" dominant-baseline="central">${text}</text>` +
    `</svg>`
  );
}

const PARROT =
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
  `<circle cx="32" cy="34" r="24" fill="#f43f5e"><animate attributeName="fill" values="#f43f5e;#f59e0b;#10b981;#3b82f6;#a855f7;#f43f5e" dur="1.2s" repeatCount="indefinite"/></circle>` +
  `<circle cx="40" cy="28" r="5" fill="#ffffff"/><circle cx="41" cy="28" r="2.5" fill="#111827"/>` +
  `<path d="M52 34 L62 38 L52 42 Z" fill="#f59e0b"/>` +
  `</svg>`;

/** The simulated Slack workspace's custom emoji (images). */
export const DEMO_EMOJI_IMAGES: readonly DemoImage[] = [
  { name: "arigato", svg: badge("感謝", "#db2777", "#ffffff", 22) },
  { name: "devhub", svg: badge("DH", "#7c3aed") },
  { name: "hai", svg: badge("はい", "#0891b2", "#ffffff", 22) },
  { name: "kit-dev", svg: badge("KIT", "#2563eb", "#ffffff", 22) },
  { name: "lgtm", svg: badge("LGTM", "#16a34a", "#ffffff", 17) },
  { name: "naruhodo", svg: badge("なるほど", "#0d9488", "#ffffff", 13) },
  { name: "ok-sign", svg: badge("OK", "#65a30d") },
  { name: "otsukare", svg: badge("おつ", "#ea580c", "#ffffff", 22) },
  { name: "partyparrot", svg: PARROT },
  { name: "shipit", svg: badge("SHIP", "#4f46e5", "#ffffff", 18) },
  { name: "wip", svg: badge("WIP", "#d97706", "#ffffff", 22) },
  { name: "yatta", svg: badge("やった", "#e11d48", "#ffffff", 17) },
];

/** Slack aliases: name -> target. `good` points at a STANDARD emoji and is skipped. */
export const DEMO_EMOJI_ALIASES: Readonly<Record<string, string>> = {
  parrot: "partyparrot",
  thanks: "arigato",
  lgtm2: "lgtm",
  good: "thumbsup",
};

/** Registered before the demo opens, so reactions show images right away. */
export const DEMO_PREIMPORTED: readonly string[] = ["devhub", "kit-dev"];

/** Images per simulated call — small so the progress visibly advances. */
export const DEMO_EMOJI_BATCH = 4;

export interface CustomEmojiSimOptions {
  /** ISO clock (injectable for tests). */
  now?: () => string;
}

export function createCustomEmojiSim({ now = () => new Date().toISOString() }: CustomEmojiSimOptions = {}) {
  const images = new Map(DEMO_EMOJI_IMAGES.map((i) => [i.name, i] as const));
  const registered = new Map<string, CustomEmoji>();
  const at = now();
  for (const name of DEMO_PREIMPORTED) registered.set(name, { name, aliasOf: null, contentType: "image/svg+xml", source: "slack", createdAt: at });

  const customAliases = Object.entries(DEMO_EMOJI_ALIASES).filter(([, target]) => images.has(target));
  const skipped = Object.keys(DEMO_EMOJI_ALIASES).length - customAliases.length;
  const importable = [...images.keys(), ...customAliases.map(([name]) => name)];

  return {
    list(): CustomEmoji[] {
      return [...registered.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    /** SVG text of `name` (an alias resolves to its target); null = unknown. */
    image(name: string): { body: string; contentType: string } | null {
      const row = registered.get(name);
      if (!row) return null;
      const img = images.get(row.aliasOf ?? row.name);
      return img ? { body: img.svg, contentType: "image/svg+xml" } : null;
    },
    importStep(after: string | null): EmojiImportResult {
      const sorted = [...images.keys()].sort();
      const pending = sorted.filter((n) => (after === null || n > after) && !registered.has(n));
      const batch = pending.slice(0, DEMO_EMOJI_BATCH);
      const before = registered.size;
      const ts = now();
      for (const name of batch) registered.set(name, { name, aliasOf: null, contentType: "image/svg+xml", source: "slack", createdAt: ts });
      for (const [name, target] of customAliases) {
        if (!registered.has(name) && registered.has(target)) registered.set(name, { name, aliasOf: target, contentType: null, source: "slack", createdAt: ts });
      }
      const last = batch[batch.length - 1];
      return {
        total: importable.length,
        imported: importable.filter((n) => registered.has(n)).length,
        added: registered.size - before,
        skipped,
        failed: [],
        nextAfter: last && pending.length > batch.length ? last : null,
        retryAfterMs: 0,
      };
    },
  };
}

export type CustomEmojiSim = ReturnType<typeof createCustomEmojiSim>;
