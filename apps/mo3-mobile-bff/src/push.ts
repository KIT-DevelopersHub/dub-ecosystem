// Push dispatch — expands a notification (userId) to the user's active devices,
// records deliveries, and sends via a platform PushAdapter. APNs/FCM real sends
// live in apns.ts/fcm.ts (HTTP + JWT injectable); tests inject a fake adapter for
// fan-out and a fake fetch/signer for the adapters. Failure audit uses
// publishAudit() — no domain event (theme1 D3).
import type { auditLog, mobile } from "@dub/types";
import type { RequestContext } from "@dub/http";
import type { DeviceRecord, DeviceStore } from "./devices";
import type { DeliveryStore } from "./deliveries";
import { type ApnsCredentials, type Es256Signer, sendApns } from "./apns";
import { type FcmAccessTokenProvider, type FcmServiceAccount, sendFcm } from "./fcm";

export type SendResult = "sent" | "token_invalid" | "failed";

export interface PushAdapter {
  /** Deliver to one device. Returns the terminal outcome (retries are internal). */
  send(device: DeviceRecord, payload: mobile.MobilePushPayload): Promise<SendResult>;
}

/** Audit payload for a delivery failure (theme1 D3; notification `delivery_failed` shape). */
export interface MobilePushDeliveryFailedAudit {
  notificationId: string;
  deviceId: string;
  platform: mobile.MobilePlatform;
  attempts: number;
  lastError: string;
}

/** Local response for POST /internal/push/dispatch (not in the frozen mobile ns). */
export interface PushDispatchResult {
  accepted: true;
  deviceCount: number; // active devices targeted (0 is not an error)
}

/**
 * Retry policy for a hard "failed" send (provider 5xx / network). A `token_invalid`
 * or `sent` outcome is terminal and never retried. maxAttempts counts the first
 * try, so 1 == the legacy single-attempt behavior. backoff/sleep are injectable so
 * tests neither wait nor touch real timers.
 */
export interface PushRetryPolicy {
  maxAttempts: number;
  backoffMs?: (nextAttempt: number) => number; // delay before attempt N (>=2)
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// Exponential: 1s before attempt 2, 2s before attempt 3, ... capped at 30s.
const DEFAULT_BACKOFF = (nextAttempt: number): number => Math.min(30_000, 1000 * 2 ** (nextAttempt - 2));

export interface PushDeps {
  devices: DeviceStore;
  deliveries: DeliveryStore;
  adapters: Record<mobile.MobilePlatform, PushAdapter>;
  audit: (input: auditLog.AuditRecordInput) => Promise<void>;
  orgId: string;
  retry?: PushRetryPolicy; // absent -> single attempt (legacy)
}

/**
 * Fan out one PushDispatchRequest to the user's active devices. Never throws for
 * an empty device set (202 / deviceCount:0). Invalid tokens disable the device
 * (auto-cleanup, no retry); hard failures are audited.
 */
export async function dispatchPush(
  deps: PushDeps,
  ctx: RequestContext,
  notificationId: string,
  req: mobile.PushDispatchRequest,
): Promise<PushDispatchResult> {
  const devices = await deps.devices.listActiveByUser(req.userId);
  const maxAttempts = Math.max(1, deps.retry?.maxAttempts ?? 1);
  const sleep = deps.retry?.sleep ?? DEFAULT_SLEEP;
  const backoff = deps.retry?.backoffMs ?? DEFAULT_BACKOFF;

  for (const device of devices) {
    const deliveryId = await deps.deliveries.createQueued(notificationId, device.id);
    const adapter = deps.adapters[device.platform];
    let result: SendResult = "failed";
    let lastError = "";
    let attempts = 0;
    // Retry only a hard "failed"; "sent"/"token_invalid" are terminal. Backoff
    // sleeps between tries (not after the last), so `attempts` is the true count.
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      try {
        result = await adapter.send(device, req.payload);
        lastError = "";
      } catch (err) {
        result = "failed";
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (result === "sent" || result === "token_invalid") break;
      if (attempt < maxAttempts) await sleep(backoff(attempt + 1));
    }

    if (result === "sent") {
      await deps.deliveries.markStatus(deliveryId, "sent", attempts, null);
    } else if (result === "token_invalid") {
      await deps.deliveries.markStatus(deliveryId, "token_invalid", attempts, "provider reported invalid token");
      await deps.devices.disableById(device.id); // stop future push to a dead token
    } else {
      await deps.deliveries.markStatus(deliveryId, "failed", attempts, lastError || "send failed");
      const details: MobilePushDeliveryFailedAudit = {
        notificationId,
        deviceId: device.id,
        platform: device.platform,
        attempts,
        lastError: lastError || "send failed",
      };
      await deps.audit({
        action: "mobile.push.delivery_failed",
        actorId: null,
        orgId: deps.orgId,
        result: "failure",
        resourceType: "notification",
        resourceId: notificationId,
        details: details as unknown as Record<string, unknown>,
        requestId: ctx.requestId,
        occurredAt: new Date().toISOString(),
      });
    }
  }

  return { accepted: true, deviceCount: devices.length };
}

// ---- production adapters ----
//
// Each adapter delegates the wire protocol to apns.ts/fcm.ts and is constructed
// either with an options object (real credentials + injectable transport) or,
// for the legacy deps.ts wiring, a boolean "configured" flag. Without credentials
// send() returns "failed" (audited upstream) and never throws — a missing secret
// or a network/provider error is a delivery failure, not a crash.

export interface ApnsAdapterOptions {
  credentials?: ApnsCredentials | null;
  fetchImpl?: typeof fetch; // inject for tests
  signer?: Es256Signer; // inject to avoid real WebCrypto in tests
  host?: string; // api.push.apple.com (prod) | api.sandbox.push.apple.com
  now?: () => number;
}

/** APNs HTTP/2 provider (p8 -> ES256 JWT -> POST /3/device/<token>). */
export class ApnsAdapter implements PushAdapter {
  private readonly opts: ApnsAdapterOptions;
  // A boolean carries no credentials (P0 stub wiring) -> send() returns "failed".
  constructor(init: boolean | ApnsAdapterOptions = false) {
    this.opts = typeof init === "boolean" ? {} : init;
  }

  async send(device: DeviceRecord, payload: mobile.MobilePushPayload): Promise<SendResult> {
    const credentials = this.opts.credentials;
    if (!credentials) return "failed";
    try {
      return await sendApns({
        credentials,
        device,
        payload,
        fetchImpl: this.opts.fetchImpl,
        signer: this.opts.signer,
        host: this.opts.host,
        now: this.opts.now,
      });
    } catch {
      return "failed"; // network/crypto/provider error -> delivery failure, audited upstream
    }
  }
}

export interface FcmAdapterOptions {
  serviceAccount?: FcmServiceAccount | null;
  projectId?: string; // falls back to serviceAccount.project_id
  fetchImpl?: typeof fetch;
  accessTokenProvider?: FcmAccessTokenProvider; // inject to avoid real OAuth/WebCrypto in tests
  now?: () => number;
}

/** FCM HTTP v1 (service account -> OAuth token -> messages:send). */
export class FcmAdapter implements PushAdapter {
  private readonly opts: FcmAdapterOptions;
  constructor(init: boolean | FcmAdapterOptions = false) {
    this.opts = typeof init === "boolean" ? {} : init;
  }

  async send(device: DeviceRecord, payload: mobile.MobilePushPayload): Promise<SendResult> {
    const serviceAccount = this.opts.serviceAccount;
    const projectId = this.opts.projectId ?? serviceAccount?.project_id;
    if (!serviceAccount || !projectId) return "failed";
    try {
      return await sendFcm({
        serviceAccount,
        projectId,
        device,
        payload,
        fetchImpl: this.opts.fetchImpl,
        accessTokenProvider: this.opts.accessTokenProvider,
        now: this.opts.now,
      });
    } catch {
      return "failed";
    }
  }
}
