// Map an @dub/errors ErrorResponse to how FE7 renders it (design §6 table).
import { CommonErrorCodes, isErrorResponse, type ErrorResponse, type FieldError } from "@dub/errors";

export type ErrorPresentation =
  | { kind: "reauth" } // UNAUTHENTICATED -> FE2 auth guard
  | { kind: "forbidden"; message: string } // 403 screen / toast
  | { kind: "empty"; message: string } // NOT_FOUND -> EmptyState
  | { kind: "field-errors"; fields: FieldError[]; message: string } // VALIDATION_FAILED
  | { kind: "conflict"; message: string } // 409 -> rollback + refetch + toast
  | { kind: "retry"; message: string; retryable: boolean }; // other / network

const JA = {
  forbidden: "権限がありません",
  notFound: "対象が見つかりません（削除済みの可能性があります）",
  validation: "入力内容を確認してください",
  conflict: "競合が発生しました。最新の状態を再取得しました",
  generic: "エラーが発生しました。時間をおいて再試行してください",
};

function extractFieldErrors(details: unknown): FieldError[] {
  if (Array.isArray(details)) return details as FieldError[];
  if (details && typeof details === "object" && Array.isArray((details as { fields?: unknown }).fields)) {
    return (details as { fields: FieldError[] }).fields;
  }
  return [];
}

/** Classify any thrown/rejected value (typed ErrorResponse or unknown network error). */
export function presentError(err: unknown): ErrorPresentation {
  if (!isErrorResponse(err)) {
    return { kind: "retry", message: JA.generic, retryable: true };
  }
  const { code, message } = (err as ErrorResponse).error;
  switch (code) {
    case CommonErrorCodes.UNAUTHENTICATED:
      return { kind: "reauth" };
    case CommonErrorCodes.FORBIDDEN:
      return { kind: "forbidden", message: message || JA.forbidden };
    case CommonErrorCodes.NOT_FOUND:
      return { kind: "empty", message: message || JA.notFound };
    case CommonErrorCodes.VALIDATION_FAILED:
      return {
        kind: "field-errors",
        fields: extractFieldErrors((err as ErrorResponse).error.details),
        message: message || JA.validation,
      };
    case CommonErrorCodes.CONFLICT:
      return { kind: "conflict", message: message || JA.conflict };
    default:
      return { kind: "retry", message: message || JA.generic, retryable: (err as ErrorResponse).error.retryable };
  }
}

/** Always-a-string message for toasts / ErrorState (reauth has no message field). */
export function errorMessage(err: unknown): string {
  const p = presentError(err);
  return p.kind === "reauth" ? "再ログインが必要です" : p.message;
}

/** Reduce FieldError[] to a { field -> message } map for FormField.error binding. */
export function fieldErrorMap(fields: readonly FieldError[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.field] = f.message ?? f.reason;
  return out;
}
