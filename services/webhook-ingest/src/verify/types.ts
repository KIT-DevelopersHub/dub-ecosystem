// Source verifier contract. A verifier authenticates the request (signature = authz)
// and extracts the source-native dedup id + event kind. It NEVER interprets payload.
import type { webhook } from "@dub/types";

export interface VerifyInput {
  rawBytes: Uint8Array; // exact received bytes (signature is over these)
  headers: Headers;
}

export interface VerifyOk {
  ok: true;
  externalId: string; // source-native delivery id (dedup key)
  eventKind: string; // source-native kind (e.g. "push")
}

export interface VerifyFail {
  ok: false;
  reason: string; // internal log detail; never returned to the caller
}

export type VerifyResult = VerifyOk | VerifyFail;

export interface VerifierSecrets {
  // current + next for rotation; consult both, accept either match
  github?: readonly (string | undefined)[];
  driveTokens?: readonly (string | undefined)[];
  stripe?: readonly (string | undefined)[];
  gmailAudience?: string;
}

export type Verifier = (input: VerifyInput, secrets: VerifierSecrets) => Promise<VerifyResult>;

/** Allow-listed headers copied into the envelope per source (never auth secrets). */
export const HEADER_ALLOWLIST: Record<webhook.WebhookSource, readonly string[]> = {
  github: [
    "x-github-event",
    "x-github-delivery",
    "x-github-hook-id",
    "x-github-hook-installation-target-type",
    "x-github-hook-installation-target-id",
    "content-type",
  ],
  "google-drive": [
    "x-goog-channel-id",
    "x-goog-message-number",
    "x-goog-resource-id",
    "x-goog-resource-state",
    "x-goog-resource-uri",
    "content-type",
  ],
  gmail: ["content-type"],
  stripe: ["stripe-signature", "content-type"],
};

export function pickAllowlistedHeaders(
  source: webhook.WebhookSource,
  headers: Headers,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADER_ALLOWLIST[source]) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}
