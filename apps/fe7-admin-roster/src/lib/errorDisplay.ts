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
  // Mail-gateway Email Routing failure modes — surfaced distinctly on the
  // 「発行済みアドレス」/ roster-sync surfaces instead of one generic line.
  unconfigured: "メール転送の管理設定が未完了です。管理者にお問い合わせください",
  upstream: "メール基盤に接続できませんでした。時間をおいて再試行してください",
};

// Service-specific codes the mail-gateway emits (see services/mail-gateway
// email-routing.ts): 503 when a CF_EMAIL_ROUTING_* secret is unset, 502 when
// Cloudflare's Email Routing API itself rejects the request.
const MAIL_EMAIL_ROUTING_UNCONFIGURED = "MAIL_EMAIL_ROUTING_UNCONFIGURED";
const MAIL_EMAIL_ROUTING_UPSTREAM = "MAIL_EMAIL_ROUTING_UPSTREAM";

/**
 * Normalize any thrown/rejected value to the wire `ErrorResponse` envelope.
 *
 * fe7 runs behind two transports: its own httpClient rejects with a bare
 * `ErrorResponse` ({ error: {...} }), but in production FE2 injects its
 * `@dub/api-client` ResourceClient, which rejects with an `ApiError` instance
 * (flat `.code`/`.message`/`.retryable` fields plus a `.body` ErrorResponse and
 * no top-level `.error`). `isErrorResponse` alone therefore missed the injected
 * transport and every failure collapsed to the generic message — this unwraps
 * both so classification is identical across transports.
 */
export function toErrorResponse(err: unknown): ErrorResponse | null {
  if (isErrorResponse(err)) return err;
  if (err && typeof err === "object") {
    // ApiError carries the original envelope on `.body`.
    const body = (err as { body?: unknown }).body;
    if (isErrorResponse(body)) return body;
    // Fallback: reconstruct from ApiError's flat fields.
    const flat = err as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown; requestId?: unknown };
    if (typeof flat.code === "string" && typeof flat.message === "string") {
      return {
        error: {
          code: flat.code,
          message: flat.message,
          retryable: flat.retryable === true,
          ...(flat.details !== undefined ? { details: flat.details } : {}),
          ...(typeof flat.requestId === "string" ? { requestId: flat.requestId } : {}),
        },
      };
    }
  }
  return null;
}

function extractFieldErrors(details: unknown): FieldError[] {
  if (Array.isArray(details)) return details as FieldError[];
  if (details && typeof details === "object" && Array.isArray((details as { fields?: unknown }).fields)) {
    return (details as { fields: FieldError[] }).fields;
  }
  return [];
}

/** Classify any thrown/rejected value (typed ErrorResponse or unknown network error). */
export function presentError(err: unknown): ErrorPresentation {
  const envelope = toErrorResponse(err);
  if (!envelope) {
    return { kind: "retry", message: JA.generic, retryable: true };
  }
  const { code, message, retryable } = envelope.error;
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
        fields: extractFieldErrors(envelope.error.details),
        message: message || JA.validation,
      };
    case CommonErrorCodes.CONFLICT:
      return { kind: "conflict", message: message || JA.conflict };
    // 未設定: a required CF_EMAIL_ROUTING_* secret is unset — not user-retryable.
    case MAIL_EMAIL_ROUTING_UNCONFIGURED:
      return { kind: "retry", message: JA.unconfigured, retryable: false };
    // 上流: Cloudflare's Email Routing API rejected — transient, retryable.
    case MAIL_EMAIL_ROUTING_UPSTREAM:
    case CommonErrorCodes.UPSTREAM_UNAVAILABLE:
    case CommonErrorCodes.UPSTREAM_TIMEOUT:
      return { kind: "retry", message: JA.upstream, retryable: true };
    // 一時: everything else — surface the server message when present.
    default:
      return { kind: "retry", message: message || JA.generic, retryable };
  }
}

/** Always-a-string message for toasts / ErrorState (reauth has no message field). */
export function errorMessage(err: unknown): string {
  const p = presentError(err);
  return p.kind === "reauth" ? "再ログインが必要です" : p.message;
}

/**
 * Project any thrown value onto @dub/ui `ErrorState`'s `DisplayableError`
 * ({ code, message }). Structurally typed to avoid importing from @dub/ui here.
 * `code` drives the ErrorState icon/presentation (FORBIDDEN -> shield, etc.).
 */
export function displayError(err: unknown): { code: string; message: string } {
  const p = presentError(err);
  const code =
    p.kind === "forbidden"
      ? "FORBIDDEN"
      : p.kind === "empty"
        ? "NOT_FOUND"
        : p.kind === "conflict"
          ? "CONFLICT"
          : p.kind === "reauth"
            ? "UNAUTHENTICATED"
            : "INTERNAL";
  return { code, message: errorMessage(err) };
}

/** Reduce FieldError[] to a { field -> message } map for FormField.error binding. */
export function fieldErrorMap(fields: readonly FieldError[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.field] = f.message ?? f.reason;
  return out;
}
