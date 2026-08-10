// Google Drive push verifier (P0 live).
//   auth      = X-Goog-Channel-Token must equal the token drive-proxy issued when it
//               created the watch channel (files.watch `token`), compared timing-safely.
//   dedup id  = "<X-Goog-Channel-Id>:<X-Goog-Message-Number>"
//   kind      = X-Goog-Resource-State (sync | add | update | ...)
// The channel token is a shared secret handed to Google at watch-creation time by
// drive-proxy; webhook-ingest holds the same value in DRIVE_WEBHOOK_TOKEN(_NEXT) and
// authenticates every callback against it. Token rotation: accept either pool entry.
import { timingSafeEqual } from "../crypto";
import type { Verifier } from "./types";

export const verifyGoogleDrive: Verifier = async (input, secrets) => {
  const channelId = input.headers.get("x-goog-channel-id");
  const messageNumber = input.headers.get("x-goog-message-number");
  const token = input.headers.get("x-goog-channel-token");
  const resourceState = input.headers.get("x-goog-resource-state") ?? "change";

  if (!channelId || !messageNumber) return { ok: false, reason: "missing channel headers" };
  const pool = secrets.driveTokens ?? [];
  if (pool.every((t) => !t)) return { ok: false, reason: "no drive token configured" };
  if (!token) return { ok: false, reason: "missing channel token" };

  const matched = pool.some((t) => (t ? timingSafeEqual(t, token) : false));
  if (!matched) return { ok: false, reason: "channel token mismatch" };

  return { ok: true, externalId: `${channelId}:${messageNumber}`, eventKind: resourceState };
};
