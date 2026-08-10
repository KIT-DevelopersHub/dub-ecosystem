// Shared best-effort extraction of a provider's error message from a non-2xx
// Response. Each provider surfaces its message under different JSON keys (SES:
// message/Message/__type; MailChannels: errors[]/message; Resend: message/name),
// so the caller passes the key priority list. Never throws and never logs creds:
// the body is read at most once, capped at 200 chars, and falls back to the raw
// text (then null) so a failing provider can still be reported without leaking.
/**
 * Whether an upstream HTTP status is worth a bounded retry. 429 (throttled) and 5xx
 * (upstream fault) are transient — the message was not accepted, so a retry is safe-ish
 * (see retry.ts for the 5xx double-send caveat). 4xx (validation / unverified domain /
 * auth) are deterministic: retrying just burns quota, so they fail fast.
 */
export function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function safeErrorDetail(res: Response, keys: readonly string[]): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const key of keys) {
        const v = j[key];
        if (Array.isArray(v) && v.length > 0) return v.join("; ").slice(0, 200);
        if (typeof v === "string" && v) return v.slice(0, 200);
      }
      return text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return null;
  }
}
