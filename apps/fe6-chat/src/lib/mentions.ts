// Mention encoding (design §8-1 #3):
//   <@userId>       — 個人メンション (frozen)
//   <!team:teamId>  — チームメンション (統括チーム / 法人チーム … チーム単位で全員へ)
// Pure helpers for parsing, autocomplete triggering, and inserting at a caret.
import type { common } from "@dub/types";
import { stripCodeSpans } from "./render-body";

const MENTION_RE = /<@([A-Za-z0-9_]+)>/g;
// team ids are member-service ULIDs ("team_01J…") — hyphen is allowed so a
// slug-shaped id never silently drops out of the token.
const TEAM_MENTION_RE = /<!team:([A-Za-z0-9_-]+)>/g;

function uniqueCaptures(body: string, re: RegExp): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // A mention inside `code` / a ``` block renders literally, so it must not count as a
  // mention either (same rule chat-service applies when it decides who to notify).
  for (const m of stripCodeSpans(body).matchAll(re)) {
    const id = m[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Unique userIds referenced by a message body, in first-seen order. */
export function extractMentions(body: string): common.UserId[] {
  return uniqueCaptures(body, MENTION_RE);
}

/** Unique teamIds referenced by a message body, in first-seen order. */
export function extractTeamMentions(body: string): string[] {
  return uniqueCaptures(body, TEAM_MENTION_RE);
}

/** True if `userId` is @-mentioned in the body. */
export function isMentioned(body: string, userId: common.UserId): boolean {
  return extractMentions(body).includes(userId);
}

/** True if any of the caller's teams is @-mentioned (チーム単位メンション). */
export function isTeamMentioned(body: string, myTeamIds: readonly string[] | undefined): boolean {
  if (!myTeamIds || myTeamIds.length === 0) return false;
  return extractTeamMentions(body).some((id) => myTeamIds.includes(id));
}

/**
 * True when the body mentions the caller either directly (<@me>) or through one
 * of their teams (<!team:…>). This is the single predicate the timeline / unread
 * badge use so both paths highlight identically.
 */
export function mentionsMe(body: string, userId: common.UserId, myTeamIds?: readonly string[]): boolean {
  return isMentioned(body, userId) || isTeamMentioned(body, myTeamIds);
}

/** One row of the composer's @-autocomplete: a person or a whole team. */
export type MentionCandidate =
  | { kind: "user"; id: common.UserId; label: string; avatarUrl?: string | null }
  | { kind: "team"; id: string; label: string; color?: string | null };

/** Wire token a picked candidate inserts into the body. */
export function mentionToken(target: common.UserId | MentionCandidate): string {
  if (typeof target === "string") return `<@${target}>`;
  return target.kind === "team" ? `<!team:${target.id}>` : `<@${target.id}>`;
}

/**
 * Body with every mention token replaced by its display name ("@統括チーム") — for the
 * places that show a one-line preview instead of rendering the body (search snippets,
 * pinned-message list). Keeps `<!team:…>` / `<@…>` wire syntax off the screen.
 */
export function toPlainMentions(
  body: string,
  resolveUserName?: (id: common.UserId) => string | undefined,
  resolveTeamName?: (id: string) => string | undefined,
): string {
  return body
    .replace(TEAM_MENTION_RE, (_m, id: string) => `@${resolveTeamName?.(id) ?? id}`)
    .replace(MENTION_RE, (_m, id: string) => `@${resolveUserName?.(id) ?? id}`);
}

export interface MentionTrigger {
  query: string; // text typed after the most recent unmatched "@"
  start: number; // index of that "@" in the text
}

/**
 * Detect an in-progress mention immediately before the caret. Returns null when
 * the caret is not in a mention context (no "@", or a space intervened).
 */
export function detectMentionTrigger(text: string, caret: number): MentionTrigger | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  // must be at start or preceded by whitespace to count as a mention trigger
  if (at > 0 && !/\s/.test(upto[at - 1]!)) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null; // a space closed the trigger
  return { query, start: at };
}

/** Replace the active trigger (from detectMentionTrigger) with the mention token. */
export function applyMention(
  text: string,
  caret: number,
  trigger: MentionTrigger,
  target: common.UserId | MentionCandidate,
): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  const after = text.slice(caret);
  const token = `${mentionToken(target)} `;
  return { text: `${before}${token}${after}`, caret: before.length + token.length };
}
