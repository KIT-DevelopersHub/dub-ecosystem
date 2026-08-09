// @dub/errors code -> FE6 UI behavior + ja display text (design §6). In the real
// SPA the ja text comes from FE2 api-client `toDisplayableError()`; FE6 owns only
// the behavioral mapping (what the UI does per code). Kept as a pure lookup.
import { CommonErrorCodes } from "@dub/errors";

export type ChatErrorAction =
  | "reauth" // hand to FE2 auth guard
  | "channel-missing" // 403/404 unified "channel not found" screen (private secrecy)
  | "inline-validation" // Composer inline error
  | "archived-banner" // disable composer + archived banner
  | "optimistic-rollback" // roll back optimistic edit/reaction, refetch
  | "rate-limited" // disable send + toast, no auto-retry
  | "generic-toast";

export interface ChatErrorDisplay {
  action: ChatErrorAction;
  message: string; // ja
}

// chat-specific SCREAMING_SNAKE codes (chat review #1). Common `CONFLICT` is NOT
// used for archived — CHAT_ARCHIVED_CHANNEL is the frozen chat code.
export const ChatErrorCodes = {
  CHAT_ARCHIVED_CHANNEL: "CHAT_ARCHIVED_CHANNEL",
} as const;

const VERSION_CONFLICT_SUFFIX = "_VERSION_CONFLICT"; // <SERVICE>_VERSION_CONFLICT (theme3 D4)

export function mapChatError(code: string): ChatErrorDisplay {
  switch (code) {
    case CommonErrorCodes.UNAUTHENTICATED:
      return { action: "reauth", message: "再ログインが必要です" };
    case CommonErrorCodes.FORBIDDEN:
    case CommonErrorCodes.NOT_FOUND:
      return { action: "channel-missing", message: "チャネルが見つかりません" };
    case CommonErrorCodes.VALIDATION_FAILED:
      return { action: "inline-validation", message: "入力内容を確認してください" };
    case ChatErrorCodes.CHAT_ARCHIVED_CHANNEL:
      return { action: "archived-banner", message: "アーカイブ済みチャネルです" };
    case CommonErrorCodes.RATE_LIMITED:
      return { action: "rate-limited", message: "送信が制限されています。しばらく待ってください" };
    default:
      if (code.endsWith(VERSION_CONFLICT_SUFFIX)) {
        return { action: "optimistic-rollback", message: "他の変更と競合しました。再取得します" };
      }
      return { action: "generic-toast", message: "エラーが発生しました" };
  }
}

export function isVersionConflict(code: string): boolean {
  return code.endsWith(VERSION_CONFLICT_SUFFIX);
}
