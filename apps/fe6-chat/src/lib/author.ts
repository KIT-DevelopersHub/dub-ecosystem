// Author display-name resolution shared across the timeline, thread pane, pins,
// and search. chat-service system posts (kind="system") carry authorId=null — they
// have no human author — so every author-name lookup must tolerate null and fall
// back to a fixed system label instead of crashing (e.g. Avatar initials → trim).
import type { common, identity } from "@dub/types";

export const SYSTEM_AUTHOR_NAME = "システム";

export type ResolveUser = (id: common.UserId) => identity.UserSummary | undefined;

/** Display name for a message author. null authorId → system label; unknown id → the id itself. */
export function authorNameOf(id: common.UserId | null, resolve?: ResolveUser): string {
  if (id === null) return SYSTEM_AUTHOR_NAME;
  return resolve?.(id)?.displayName ?? id;
}
