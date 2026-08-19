// Maps a server ErrorResponse code to the FE4 UX behaviour (design §6). The
// @dub/errors catalog is the single source; codes are common OR the service
// SCREAMING_SNAKE form (`TASK_VERSION_CONFLICT` etc). No slash-lowercase forms.
import { CommonErrorCodes } from "@dub/errors";
import type { DisplayableError } from "../contracts/spa-shell";

export type ErrorUxAction =
  | "reauth" // 401 -> FE2 auth guard
  | "readonly_fallback" // 403 -> disable edit UI + toast
  | "not_found" // 404 task/gantt event
  | "recreate_options" // 404 task event gone at create time
  | "field_errors" // 400 validation -> FieldError inline
  | "rollback_refetch" // 409 version conflict
  | "dependency_cycle_inline" // 409 dependency cycle (task edit)
  | "rollback_transition" // 409 invalid status transition (board)
  | "gantt_cycle_banner" // 422 gantt dependency cycle
  | "toast_retry_backoff" // 429 rate limited
  | "retry_button" // 5xx upstream unavailable
  | "toast_generic";

export interface ErrorUx {
  action: ErrorUxAction;
  message: string;
}

export function mapError(e: DisplayableError): ErrorUx {
  switch (e.code) {
    case CommonErrorCodes.UNAUTHENTICATED:
      return { action: "reauth", message: "再ログインが必要です" };
    case CommonErrorCodes.FORBIDDEN:
      return { action: "readonly_fallback", message: "権限がありません" };
    case "TASK_NOT_FOUND":
    case "GANTT_EVENT_NOT_FOUND":
      return { action: "not_found", message: "対象が見つかりませんでした" };
    case "TASK_EVENT_NOT_FOUND":
      return { action: "recreate_options", message: "イベント/アクションが削除されています。選択肢を再取得します" };
    case CommonErrorCodes.VALIDATION_FAILED:
    case "TASK_VALIDATION_FAILED":
      return { action: "field_errors", message: "入力内容を確認してください" };
    case CommonErrorCodes.CONFLICT:
    case "TASK_VERSION_CONFLICT":
      return { action: "rollback_refetch", message: "他の人が更新しました。最新を取得しました" };
    case "TASK_DEPENDENCY_CYCLE":
      return { action: "dependency_cycle_inline", message: "依存関係が循環しています" };
    case "TASK_INVALID_STATUS_TRANSITION":
      return { action: "rollback_transition", message: "その状態へは移動できません" };
    case "GANTT_DEPENDENCY_CYCLE":
      return { action: "gantt_cycle_banner", message: "依存関係に循環があります" };
    case CommonErrorCodes.RATE_LIMITED:
      return { action: "toast_retry_backoff", message: "混み合っています。少し待って再試行してください" };
    case CommonErrorCodes.UPSTREAM_UNAVAILABLE:
    case CommonErrorCodes.UPSTREAM_TIMEOUT:
    case "GANTT_UPSTREAM_UNAVAILABLE":
      return { action: "retry_button", message: "接続できませんでした。再試行してください" };
    default:
      return { action: "toast_generic", message: e.message || "エラーが発生しました" };
  }
}

/** Where an error is shown. `dialog` = blocking ErrorDialog (the reason must be
 *  seen — save dropped, permission, dependency cycle, validation, generic/5xx).
 *  `banner` = quiet inline notice for auto-recovered cases (a conflict we already
 *  refetched, a read-only fallback, a rate-limit backoff) where a modal would nag. */
export function errorSurface(action: ErrorUxAction): "dialog" | "banner" {
  switch (action) {
    case "rollback_refetch":
    case "rollback_transition":
    case "readonly_fallback":
    case "toast_retry_backoff":
      return "banner";
    default:
      return "dialog";
  }
}

/** validation FieldError[] -> {field: message} map for inline form rendering. */
export function fieldErrorMap(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d && typeof d === "object" && typeof (d as { field?: unknown }).field === "string") {
        const fe = d as { field: string; reason?: string; message?: string };
        out[fe.field] = fe.message ?? fe.reason ?? "invalid";
      }
    }
  }
  return out;
}
