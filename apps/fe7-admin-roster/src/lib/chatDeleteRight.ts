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

// ---- 4-choice UI selector (folds the workspace protectReacted flag into 削除あり(単)) ----
// The role editor presents ONE 削除権限 segment with four ordered steps. The middle two
// share the same per-role key (chat:delete = 自分の投稿を削除) and differ only by the
// workspace-wide protectReacted flag, so choosing between them writes that org policy
// (moderators/admin are exempt regardless). Ordered by how restrictive they are:
//   none          = 削除不可                        (no key)
//   own_protected = リアクション付きは削除不可        (chat:delete + protectReacted ON)
//   own           = 自分の投稿のみ削除               (chat:delete + protectReacted OFF)
//   any           = 全員の投稿を削除（モデレート）    (chat:moderate)
export type ChatDeleteChoice = "none" | "own_protected" | "own" | "any";

/** Fold the role's key-level 削除権限 and the workspace protectReacted flag into the
 *  4-choice shown in the segment. Only the `own` tier splits on protectReacted. */
export function chatDeleteChoice(selected: readonly PermissionKey[], protectReacted: boolean): ChatDeleteChoice {
  const right = chatDeleteRight(selected);
  if (right === "any") return "any";
  if (right === "own") return protectReacted ? "own_protected" : "own";
  return "none";
}

/** Resolve a 4-choice back to (a) the role's new key set and (b) the workspace
 *  protectReacted value to persist. Only the two `own` steps set protectReacted; `none`
 *  and `any` leave it unchanged (nothing to protect / moderators are exempt anyway). */
export function applyChatDeleteChoice(
  selected: readonly PermissionKey[],
  choice: ChatDeleteChoice,
  currentProtect: boolean,
): { keys: PermissionKey[]; protectReacted: boolean } {
  switch (choice) {
    case "own_protected":
      return { keys: setChatDeleteRight(selected, "own"), protectReacted: true };
    case "own":
      return { keys: setChatDeleteRight(selected, "own"), protectReacted: false };
    case "any":
      return { keys: setChatDeleteRight(selected, "any"), protectReacted: currentProtect };
    case "none":
    default:
      return { keys: setChatDeleteRight(selected, "none"), protectReacted: currentProtect };
  }
}
