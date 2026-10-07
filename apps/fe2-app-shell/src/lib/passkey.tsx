// Browser half of passkey login / registration. @simplewebauthn/browser turns the server's
// options JSON into navigator.credentials calls and back; the server does every check.
// Errors are normalised into PasskeyOutcome so screens can tell "the user just closed
// the prompt" (stay quiet, offer the password) from a real failure.
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ApiError, toDisplayableError, type ApiClient, type PasskeySummary } from "./api-client.tsx";

export type PasskeyOutcome =
  | { ok: true }
  | { ok: false; kind: "cancelled" | "unsupported" | "disabled" | "error"; message: string };

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

/** The user closed / timed out the OS prompt, or no passkey exists for this site. */
function isCancel(e: unknown): boolean {
  const name = (e as { name?: string; cause?: { name?: string } } | null)?.name;
  const causeName = (e as { cause?: { name?: string } } | null)?.cause?.name;
  return name === "NotAllowedError" || causeName === "NotAllowedError" || name === "AbortError";
}

function failure(e: unknown, fallback: string): PasskeyOutcome {
  if (ApiError.isApiError(e)) {
    if (e.code === "AUTH_PASSKEY_DISABLED") return { ok: false, kind: "disabled", message: toDisplayableError(e).message };
    return { ok: false, kind: "error", message: toDisplayableError(e).message };
  }
  if (isCancel(e)) return { ok: false, kind: "cancelled", message: fallback };
  return { ok: false, kind: "error", message: fallback };
}

/** Usernameless sign-in. On ok the session cookie is set; the caller navigates. */
export async function signInWithPasskey(api: ApiClient): Promise<PasskeyOutcome> {
  if (!passkeysSupported()) return { ok: false, kind: "unsupported", message: "このブラウザはパスキーに対応していません。" };
  try {
    const optionsJSON = await api.auth.passkeys.loginOptions();
    const response = await startAuthentication({ optionsJSON });
    await api.auth.passkeys.loginVerify(response);
    return { ok: true };
  } catch (e) {
    return failure(e, "パスキーでログインできませんでした。パスワードでログインしてください。");
  }
}

/** Register a passkey for the signed-in user. `password` is the step-up re-entry. */
export async function registerPasskey(
  api: ApiClient,
  password: string,
  label: string,
): Promise<{ ok: true; passkey: PasskeySummary } | Exclude<PasskeyOutcome, { ok: true }>> {
  if (!passkeysSupported()) return { ok: false, kind: "unsupported", message: "このブラウザはパスキーに対応していません。" };
  try {
    const optionsJSON = await api.auth.passkeys.registerOptions(password);
    const response = await startRegistration({ optionsJSON });
    const { passkey } = await api.auth.passkeys.registerVerify(response, label);
    return { ok: true, passkey };
  } catch (e) {
    const out = failure(e, "パスキーを登録できませんでした。");
    return out.ok ? { ok: false, kind: "error", message: "パスキーを登録できませんでした。" } : out;
  }
}

/** Default label from the device the user is on ("Mac", "iPhone", ...). */
export function defaultPasskeyLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X|Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "パスキー";
}
