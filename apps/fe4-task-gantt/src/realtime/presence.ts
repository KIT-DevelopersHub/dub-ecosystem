// Pure helpers for the presence avatars — a deterministic colour per user (same person
// ⇒ same colour, always) and an initial extracted from the display label (CJK surname
// first char / Latin first 1–2 letters). No React here so it is trivially unit-tested.
import type { common, gantt } from "@dub/types";

/** FNV-ish stable hash of a user id → 0..2^32-1 (deterministic across sessions/clients). */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic avatar background for a user. HSL with fixed S/L chosen so that white
 *  text on top always clears WCAG AA (≈4.5:1) — the hue is the only free variable, so
 *  every user gets a distinct-but-legible colour without a hand-maintained palette. */
export function avatarColor(userId: common.UserId | string): string {
  const hue = hashId(userId) % 360;
  return `hsl(${hue} 58% 42%)`;
}

/** First glyph(s) for the avatar. A Latin label yields up to two initials (first letters
 *  of the first two words, or the first two chars); a CJK label yields its first
 *  character (typically the surname). Falls back to "?" for an empty label. */
export function avatarInitials(label: string | undefined | null): string {
  const s = (label ?? "").trim();
  if (!s) return "?";
  // ASCII-only ⇒ Latin name: take word initials.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]+$/.test(s)) {
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length > 1) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }
  // Non-ASCII (e.g. 日本語): the first grapheme is the surname's first character.
  return Array.from(s)[0]!;
}

/** Resolve a presence user's best available label: the DO-signed displayName, else a
 *  roster lookup, else the raw id. Keeps the avatar bar populated even before the roster
 *  batch resolves. */
export function presenceLabel(
  user: gantt.GanttPresenceUser,
  displayNameById: ReadonlyMap<common.UserId, string>,
): string {
  return user.displayName || displayNameById.get(user.userId) || user.userId;
}
