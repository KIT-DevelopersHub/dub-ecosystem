// Mention encoding is `<@userId>` (design §8-1 #3, frozen). Pure helpers for
// parsing, autocomplete triggering, and inserting a mention at a caret.
import type { common } from "@dub/types";

const MENTION_RE = /<@([A-Za-z0-9_]+)>/g;

/** Unique userIds referenced by a message body, in first-seen order. */
export function extractMentions(body: string): common.UserId[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    const id = m[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** True if `userId` is @-mentioned in the body. */
export function isMentioned(body: string, userId: common.UserId): boolean {
  return extractMentions(body).includes(userId);
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

/** Replace the active trigger (from detectMentionTrigger) with `<@userId> `. */
export function applyMention(
  text: string,
  caret: number,
  trigger: MentionTrigger,
  userId: common.UserId,
): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  const after = text.slice(caret);
  const token = `<@${userId}> `;
  return { text: `${before}${token}${after}`, caret: before.length + token.length };
}
