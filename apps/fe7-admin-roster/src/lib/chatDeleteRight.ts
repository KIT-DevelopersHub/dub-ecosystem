// Pure logic for the chat "削除権限" 3-choice, folded into the チャット row of the
// app-access section. Maps the choice ⇄ the role's chat delete permission keys:
//   なし        = neither key            (cannot delete, not even own)
//   削除あり(単) = chat:delete            (delete OWN messages only)
//   複数削除あり = chat:moderate          (delete ANYONE's — moderator)
// The three states are mutually exclusive on {chat:delete, chat:moderate}. No React
// here → exhaustively unit-testable (mirrors lib/appAccessMatrix).
import type { identity } from "@dub/types";

export type PermissionKey = identity.PermissionKey;

/** none = 削除権限なし / own = 削除あり(単) / any = 複数削除あり. */
export type ChatDeleteRight = "none" | "own" | "any";

const DELETE_KEY: PermissionKey = "chat:delete";
const MODERATE_KEY: PermissionKey = "chat:moderate";

/** The keys this row owns (hidden from the flat "chat" domain grid, controlled here). */
export const CHAT_DELETE_KEYS: readonly PermissionKey[] = [DELETE_KEY, MODERATE_KEY];

/** Current 削除権限 for a role given its selected key set. moderate wins over delete. */
export function chatDeleteRight(selected: readonly PermissionKey[]): ChatDeleteRight {
  const set = new Set(selected);
  if (set.has(MODERATE_KEY)) return "any";
  if (set.has(DELETE_KEY)) return "own";
  return "none";
}

/** A NEW sorted key set with the chat 削除権限 set to `right` (mutually exclusive keys). */
export function setChatDeleteRight(selected: readonly PermissionKey[], right: ChatDeleteRight): PermissionKey[] {
  const set = new Set(selected);
  set.delete(DELETE_KEY);
  set.delete(MODERATE_KEY);
  if (right === "own") set.add(DELETE_KEY);
  else if (right === "any") set.add(MODERATE_KEY);
  return [...set].sort();
}

/** The org deletion-policy tier this role's deletions resolve to (server-side): a
 *  moderator (複数削除) uses the `moderator` tier; anyone else the `member` tier. */
export function chatDeletionTier(right: ChatDeleteRight): "member" | "moderator" {
  return right === "any" ? "moderator" : "member";
}
