// GitHub webhook verifier (P0 live).
//   dedup id  = X-GitHub-Delivery
//   kind      = X-GitHub-Event
//   signature = X-Hub-Signature-256 : "sha256=<hex>" = HMAC-SHA256(secret, rawBody)
// Secret rotation: accept a match against GITHUB_WEBHOOK_SECRET or ..._NEXT (test #14).
import { hmacMatchesAny } from "../crypto";
import type { Verifier } from "./types";

const SIG_PREFIX = "sha256=";

export const verifyGithub: Verifier = async (input, secrets) => {
  const delivery = input.headers.get("x-github-delivery");
  const event = input.headers.get("x-github-event");
  const sigHeader = input.headers.get("x-hub-signature-256");

  if (!delivery) return { ok: false, reason: "missing X-GitHub-Delivery" };
  if (!event) return { ok: false, reason: "missing X-GitHub-Event" };
  if (!sigHeader || !sigHeader.startsWith(SIG_PREFIX)) {
    return { ok: false, reason: "missing/invalid X-Hub-Signature-256" };
  }
  const candidate = sigHeader.slice(SIG_PREFIX.length).toLowerCase();

  const pool = secrets.github ?? [];
  if (pool.every((s) => !s)) return { ok: false, reason: "no github secret configured" };

  const ok = await hmacMatchesAny(pool, input.rawBytes, candidate);
  if (!ok) return { ok: false, reason: "signature mismatch" };

  return { ok: true, externalId: delivery, eventKind: event };
};
