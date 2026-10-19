// Slack custom emoji (emoji.list) — pure helpers shared by chat-service's emoji import.
//
// emoji.list answers `{ emoji: { <name>: <image url> | "alias:<other name>" } }`. An alias owns
// no image: it is stored with `alias_of` and renders its target's image. Names are used as the
// R2 key suffix and as a URL path segment, so anything that could break either is rejected.

export interface SlackEmojiImage {
  name: string;
  url: string;
}

export interface SlackEmojiAlias {
  name: string;
  /** Target emoji name (may be a standard emoji such as "thumbsup", not a custom one). */
  target: string;
}

export interface ParsedSlackEmoji {
  /** Sorted by name — the import cursor walks this order. */
  images: SlackEmojiImage[];
  /** Sorted by name. */
  aliases: SlackEmojiAlias[];
  /** Entries rejected up front (unsafe name / unsupported value). */
  invalid: string[];
}

const ALIAS_PREFIX = "alias:";
const NAME_MAX = 100;

/** Usable as `:name:`, an R2 key suffix and a URL path segment. */
export function isValidCustomEmojiName(name: string): boolean {
  if (name.length === 0 || name.length > NAME_MAX) return false;
  if (name === "." || name === "..") return false;
  return !/[\s:/\\?#%<>"'`&]/.test(name) && !/[\u0000-\u001f\u007f]/.test(name);
}

/** Only Slack's own CDN — the import never fetches an arbitrary host. */
export function isSlackEmojiUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return host === "emoji.slack-edge.com" || host.endsWith(".slack-edge.com");
}

export function parseSlackEmojiList(map: Readonly<Record<string, string>>): ParsedSlackEmoji {
  const images: SlackEmojiImage[] = [];
  const aliases: SlackEmojiAlias[] = [];
  const invalid: string[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (!isValidCustomEmojiName(name) || typeof value !== "string") {
      invalid.push(name);
      continue;
    }
    if (value.startsWith(ALIAS_PREFIX)) {
      const target = value.slice(ALIAS_PREFIX.length);
      if (isValidCustomEmojiName(target)) aliases.push({ name, target });
      else invalid.push(name);
    } else if (isSlackEmojiUrl(value)) {
      images.push({ name, url: value });
    } else {
      invalid.push(name);
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { images: images.sort(byName), aliases: aliases.sort(byName), invalid: invalid.sort() };
}

/** Raster formats a browser renders in <img> and that cannot carry script (no SVG). */
export const CUSTOM_EMOJI_CONTENT_TYPES: readonly string[] = ["image/png", "image/gif", "image/jpeg", "image/webp"];

const EXT_TYPES: Readonly<Record<string, string>> = { png: "image/png", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * The stored content type: the response header when it is an allowed raster type, else the
 * URL extension. null = not an image we serve (the emoji is skipped, never re-encoded).
 */
export function customEmojiContentType(header: string | null, url: string): string | null {
  const fromHeader = header?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (CUSTOM_EMOJI_CONTENT_TYPES.includes(fromHeader)) return fromHeader;
  let ext = "";
  try {
    ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  } catch {
    return null;
  }
  return EXT_TYPES[ext] ?? null;
}

/** R2 key of an emoji image (bucket dub-file-attachments, prefix custom-emoji/). */
export function customEmojiR2Key(name: string): string {
  return `custom-emoji/${name}`;
}
