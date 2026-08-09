// Map @dub/errors codes → user-facing Japanese copy (design §6 table).
// Handles both common codes (@dub/errors/wire CommonErrorCodes) and the gateway
// service-specific code GATEWAY_TURNSTILE_FAILED (open half `<SERVICE>_<REASON>`).

import type { ErrorCode } from "@dub/errors/wire";

/** Sentinel for fetch/network failure (no HTTP response reached us). */
export const NETWORK_ERROR = "NETWORK_ERROR";

const MESSAGES: Record<string, string> = {
  VALIDATION_FAILED: "入力内容に誤りがあります。各項目をご確認ください。",
  GATEWAY_TURNSTILE_FAILED: "認証に失敗しました。ページを再読み込みして、もう一度送信してください。",
  FORBIDDEN: "認証に失敗しました。ページを再読み込みして、もう一度送信してください。",
  RATE_LIMITED: "送信が集中しています。しばらく時間を置いてから再送信してください。",
  PAYLOAD_TOO_LARGE: "お問い合わせ内容が大きすぎます。短くしてお試しください。",
  UPSTREAM_UNAVAILABLE: "現在送信できません。しばらくしてからもう一度お試しください。",
  UPSTREAM_TIMEOUT: "送信がタイムアウトしました。もう一度お試しください。",
  [NETWORK_ERROR]: "通信に失敗しました。ネットワークをご確認のうえ再送信してください。入力内容は保持されています。",
};

const FALLBACK = "送信に失敗しました。しばらくしてからもう一度お試しください。入力内容は保持されています。";

/** True when the failure warrants resetting the Turnstile widget. */
export function shouldResetTurnstile(code: ErrorCode | typeof NETWORK_ERROR): boolean {
  return code === "GATEWAY_TURNSTILE_FAILED" || code === "FORBIDDEN";
}

/** True when the user may safely retry the same submission (idempotency-guarded). */
export function isRetryable(code: ErrorCode | typeof NETWORK_ERROR): boolean {
  return (
    code === NETWORK_ERROR ||
    code === "RATE_LIMITED" ||
    code === "UPSTREAM_UNAVAILABLE" ||
    code === "UPSTREAM_TIMEOUT" ||
    code === "INTERNAL"
  );
}

export function errorCodeToUserMessage(code: ErrorCode | typeof NETWORK_ERROR): string {
  return MESSAGES[code] ?? FALLBACK;
}
