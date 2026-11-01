// Custom emoji — pure helpers + the browser-side Slack import driver.
// chat-service imports a bounded batch per POST (cursor = last name), so the open import
// screen is the engine: driveEmojiImport loops until nextAfter is null, waiting out Slack
// rate limits (retryAfterMs). Re-running is cheap: registered names are skipped server-side.
import type { ChatApiClient } from "../api/client";
import type { CustomEmoji, EmojiImportResult } from "../api/contract";

/** Liveness marker rendered by the picker's カスタム tab + import modal (deploy:demo / verify:live). */
export const CUSTOM_EMOJI_MARKER = "custom-emoji-v1";

const SHORTCODE = /^:([^\s:]+):$/;

/** ":partyparrot:" -> "partyparrot"; anything else (a Unicode glyph) -> null. */
export function shortcodeName(emoji: string): string | null {
  return SHORTCODE.exec(emoji)?.[1] ?? null;
}

export function toShortcode(name: string): string {
  return `:${name}:`;
}

/** The emoji whose image `name` renders (alias -> target). null = not a known custom emoji. */
export function resolveCustomEmoji(byName: ReadonlyMap<string, CustomEmoji>, name: string): CustomEmoji | null {
  const e = byName.get(name);
  if (!e) return null;
  if (!e.aliasOf) return e;
  return byName.get(e.aliasOf) ?? null;
}

/** Name search for the picker: case-insensitive substring, ":" tolerated. */
export function filterCustomEmojis(list: readonly CustomEmoji[], query: string): CustomEmoji[] {
  const q = query.trim().toLowerCase().replace(/:/g, "");
  if (!q) return [...list];
  return list.filter((e) => e.name.toLowerCase().includes(q));
}

/** HTTP error -> the sentence the import screen shows. */
export function describeEmojiImportError(e: unknown): string {
  const err = (e ?? {}) as { status?: number; message?: string };
  switch (err.status) {
    case 412:
      return "Slack 連携がまだ設定されていません。管理者に SLACK_BOT_TOKEN の設定を依頼してください。";
    case 403:
      return "絵文字を取り込む権限がありません。";
    case 409:
      return err.message || "Slack 側でエラーが発生しました。";
    default:
      return "取り込みの通信に失敗しました。もう一度お試しください。";
  }
}

/** Gap between batches so the server (or the demo) is not hammered. */
export const EMOJI_STEP_INTERVAL_MS = 300;

export interface EmojiDriveOptions {
  onUpdate: (result: EmojiImportResult) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

/** Run the import from the top until finished or aborted. Network errors reject. */
export async function driveEmojiImport(
  api: Pick<ChatApiClient, "importSlackEmojis">,
  { onUpdate, signal, sleep = defaultSleep }: EmojiDriveOptions,
): Promise<EmojiImportResult | null> {
  let after: string | null = null;
  let last: EmojiImportResult | null = null;
  while (!signal?.aborted) {
    const r = await api.importSlackEmojis(after);
    if (signal?.aborted) break;
    last = r;
    onUpdate(r);
    if (r.retryAfterMs > 0) {
      await sleep(r.retryAfterMs);
      continue;
    }
    if (r.nextAfter === null) break;
    after = r.nextAfter;
    await sleep(EMOJI_STEP_INTERVAL_MS);
  }
  return last;
}
