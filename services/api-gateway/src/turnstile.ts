// Cloudflare Turnstile siteverify (public inquiry bot defense). Injectable so tests
// never touch the network; the default calls the real siteverify endpoint.
import { retryFetch } from "@dub/http";

export type TurnstileVerifier = (token: string, remoteIp: string | null) => Promise<boolean>;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
}

/** Real verifier bound to a secret. Absent secret => always fails closed. */
export function createTurnstileVerifier(secret: string | undefined): TurnstileVerifier {
  return async (token, remoteIp) => {
    if (!secret) return false;
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (remoteIp) form.set("remoteip", remoteIp);
    try {
      const res = await retryFetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        timeoutMs: 3000,
      });
      if (!res.ok) return false;
      const data = (await res.json()) as SiteverifyResponse;
      return data.success === true;
    } catch {
      return false;
    }
  };
}
