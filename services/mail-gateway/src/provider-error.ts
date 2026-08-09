// Shared best-effort extraction of a provider's error message from a non-2xx
// Response. Each provider surfaces its message under different JSON keys (SES:
// message/Message/__type; MailChannels: errors[]/message; Resend: message/name),
// so the caller passes the key priority list. Never throws and never logs creds:
// the body is read at most once, capped at 200 chars, and falls back to the raw
// text (then null) so a failing provider can still be reported without leaking.
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
