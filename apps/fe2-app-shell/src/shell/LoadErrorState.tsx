// Shared "読み込みに失敗した" state (#855). Every screen that fetches data renders THIS on
// failure — never its empty state — so a 429/5xx never reads as "0 件". The transport
// (lib/api-client) has already retried 429 (Retry-After) and 5xx before we get here.
import { ErrorState } from "@dub/ui";
import type { DisplayableError } from "@dub/ui";
import { ApiError } from "../lib/api-client.tsx";

/** Why a load failed, in Japanese, for the user (subject = what was being loaded). */
export function describeLoadError(error: unknown, subject = "データ"): DisplayableError {
  const head = `${subject}を読み込めませんでした。`;
  if (!ApiError.isApiError(error)) {
    return { code: "UNKNOWN", message: `${head}時間をおいて再試行してください。` };
  }
  const reason =
    error.status === 429
      ? "アクセスが集中しています。少し待ってから再試行してください。"
      : error.status === 0
        ? "ネットワークに接続できませんでした。接続を確認して再試行してください。"
        : error.status >= 500
          ? "サーバーで一時的な問題が起きています。時間をおいて再試行してください。"
          : error.status === 403
            ? "表示する権限がありません。"
            : "時間をおいて再試行してください。";
  const out: DisplayableError = { code: error.status === 429 ? "RATE_LIMITED" : error.code, message: head + reason };
  if (error.requestId !== undefined) out.correlationId = error.requestId;
  return out;
}

export function LoadErrorState({
  error,
  onRetry,
  subject,
  testId = "fe2-load-error",
}: {
  error: unknown;
  onRetry?: () => void;
  subject?: string;
  testId?: string;
}): JSX.Element {
  return <ErrorState error={describeLoadError(error, subject)} {...(onRetry ? { onRetry } : {})} testId={testId} />;
}
