// chat — Slack times チャンネル自動作成 (#850). Re-exported from chat.ts (namespace `chat`).
// Routes (chat-service):
//   GET  /chat/slack-times/preview  dry-run: who would get which channel (no Slack writes)
//   POST /chat/slack-times/bulk     create for members without one (bounded batch, re-callable)
//   POST /internal/events-async     identity.user.activated -> create for that member
import type { ISODateTime, UserId } from "./common";

/** Effective config (env vars on chat-service; defaults in brackets). */
export interface SlackTimesConfig {
  /** Channel name prefix [`times-`]. */
  prefix: string;
  /** Create as a private channel [false = public]. */
  isPrivate: boolean;
  /** Create automatically when a member is activated [true]. */
  autoCreate: boolean;
}

/** How a member's times channel was (or would be) resolved. */
export type SlackTimesStatus =
  | "created" // the bot created it
  | "existing" // a channel with the planned name already existed -> recorded, not created
  | "recorded" // already recorded in D1 (nothing to do)
  | "no_slack_account" // no Slack user with the member's email
  | "failed";

/** One row of the dry-run preview / bulk result. */
export interface SlackTimesItem {
  userId: UserId;
  displayName: string;
  email: string;
  /** Planned (preview) or final (bulk) channel name; null when no Slack account. */
  channelName: string | null;
  slackUserId: string | null;
  slackChannelId: string | null;
  status: SlackTimesStatus | "planned";
  /** Admin-facing reason for `failed`. */
  error: string | null;
}

/** GET /chat/slack-times/preview */
export interface SlackTimesPreviewResponse {
  config: SlackTimesConfig;
  /** Members without a recorded times channel (the bulk target). */
  items: SlackTimesItem[];
  /** Members that already have one recorded. */
  recordedCount: number;
}

/** POST /chat/slack-times/bulk body. `userIds` omitted = every member in the preview. */
export interface SlackTimesBulkRequest {
  userIds?: UserId[];
}

/** POST /chat/slack-times/bulk response. Call again while `remaining > 0`. */
export interface SlackTimesBulkResponse {
  results: SlackTimesItem[];
  remaining: number;
}

/**
 * Error code for a token without the needed scopes (412 / `slack_missing_scope`).
 * details.neededScopes lists what to add in the Slack app's OAuth & Permissions page.
 */
export const SLACK_TIMES_REQUIRED_SCOPES = [
  "channels:manage",
  "channels:read",
  "channels:write.invites",
  "groups:write",
  "groups:write.invites",
  "users:read",
  "users:read.email",
] as const;

/** D1 row shape (chat_slack_times). */
export interface SlackTimesRecord {
  userId: UserId;
  slackUserId: string;
  slackChannelId: string;
  channelName: string;
  status: "created" | "existing";
  createdAt: ISODateTime;
}
