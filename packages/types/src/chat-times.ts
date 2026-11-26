// chat — メンバーごとの times チャンネル自動作成 (#850). Dub チャット内のチャンネル
// (外部 Slack ではない). Re-exported from chat.ts (namespace `chat`).
// Routes (chat-service):
//   GET  /chat/times/preview      dry-run: who would get which channel (nothing is created)
//   POST /chat/times/bulk         create for members without one (bounded batch, re-callable)
//   POST /internal/events-async   identity.user.activated -> create for that member
import type { ChannelId, ISODateTime, UserId } from "./common";

/** Effective config (env vars on chat-service; defaults in brackets). */
export interface TimesConfig {
  /** Channel name prefix [`times-`]. */
  prefix: string;
  /** Create as a private channel [false = public]. */
  isPrivate: boolean;
  /** Create automatically when a member is activated [true]. */
  autoCreate: boolean;
}

/** How a member's times channel was (or would be) resolved. */
export type TimesStatus =
  | "created" // created now (owner = the member)
  | "existing" // the member already owns a channel with the planned name -> recorded, not created
  | "recorded" // already recorded (nothing to do)
  | "failed";

/** One row of the dry-run preview / bulk result. */
export interface TimesItem {
  userId: UserId;
  displayName: string;
  email: string;
  /** Planned (preview) or final (bulk) channel name. */
  channelName: string | null;
  /** The Dub chat channel (null while only planned). */
  channelId: ChannelId | null;
  status: TimesStatus | "planned";
  /** Admin-facing reason for `failed`. */
  error: string | null;
}

/** GET /chat/times/preview */
export interface TimesPreviewResponse {
  config: TimesConfig;
  /** Members without a recorded times channel (the bulk target). */
  items: TimesItem[];
  /** Members that already have one recorded. */
  recordedCount: number;
}

/** POST /chat/times/bulk body. `userIds` omitted = every member in the preview. */
export interface TimesBulkRequest {
  userIds?: UserId[];
}

/** POST /chat/times/bulk response. Call again while `remaining > 0`. */
export interface TimesBulkResponse {
  results: TimesItem[];
  remaining: number;
}

/** D1 row shape (chat_times). */
export interface TimesRecord {
  userId: UserId;
  channelId: ChannelId;
  channelName: string;
  status: "created" | "existing";
  createdAt: ISODateTime;
}

export const TIMES_DEFAULT_PREFIX = "times-";
export const TIMES_CHANNEL_NAME_MAX = 80;
/** Collision suffixes tried: base, base-2 … base-N. */
export const TIMES_MAX_SUFFIX = 20;

/**
 * Channel-name slug: NFKC, lowercase, anything but letters / digits / `_` / `-` becomes `-`,
 * runs collapsed, leading/trailing `-` trimmed (a prefix keeps its trailing separator).
 * Letters include Japanese and other non-Latin scripts (it is our own chat).
 */
export function timesSlug(raw: string, keepTrailing = false): string {
  let s = raw.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-{2,}/g, "-");
  s = s.replace(/^-+/, "");
  if (!keepTrailing) s = s.replace(/[-_]+$/, "");
  return s;
}

/** Base channel name for a member: Dub display name, else the email local part. */
export function timesBaseName(prefix: string, member: { displayName: string; email: string }): string {
  const room = TIMES_CHANNEL_NAME_MAX - prefix.length - 3; // keep room for "-NN"
  for (const c of [member.displayName, member.email.split("@")[0]]) {
    const slug = c ? timesSlug(c).slice(0, room).replace(/[-_]+$/, "") : "";
    if (slug) return `${prefix}${slug}`;
  }
  return `${prefix}member`;
}

/** The i-th candidate (1 = base, 2 = base-2, …). */
export function timesCandidate(base: string, i: number): string {
  return i === 1 ? base : `${base}-${i}`;
}
