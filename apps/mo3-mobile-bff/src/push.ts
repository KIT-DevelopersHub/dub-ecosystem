// Push dispatch — expands a notification (userId) to the user's active devices,
// records deliveries, and sends via a platform PushAdapter. APNs/FCM实送信 is
// interface-frozen and stubbed in P0 (theme8/8-9, 9-D wave); tests inject a fake
// adapter. Failure audit uses publishAudit() — no domain event (theme1 D3).
import type { auditLog, mobile } from "@dub/types";
import type { RequestContext } from "@dub/http";
import type { DeviceRecord, DeviceStore } from "./devices";
import type { DeliveryStore } from "./deliveries";

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

export interface PushDeps {
  devices: DeviceStore;
  deliveries: DeliveryStore;
  adapters: Record<mobile.MobilePlatform, PushAdapter>;
  audit: (input: auditLog.AuditRecordInput) => Promise<void>;
  orgId: string;
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

  for (const device of devices) {
    const deliveryId = await deps.deliveries.createQueued(notificationId, device.id);
    const adapter = deps.adapters[device.platform];
    let result: SendResult = "failed";
    let lastError = "";
    try {
      result = await adapter.send(device, req.payload);
    } catch (err) {
      result = "failed";
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (result === "sent") {
      await deps.deliveries.markStatus(deliveryId, "sent", 1, null);
    } else if (result === "token_invalid") {
      await deps.deliveries.markStatus(deliveryId, "token_invalid", 1, "provider reported invalid token");
      await deps.devices.disableById(device.id); // stop future push to a dead token
    } else {
      await deps.deliveries.markStatus(deliveryId, "failed", 1, lastError || "send failed");
      const details: MobilePushDeliveryFailedAudit = {
        notificationId,
        deviceId: device.id,
        platform: device.platform,
        attempts: 1,
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

// ---- production adapters (interface-frozen, P0 stub) ----

/** APNs HTTP/2 provider (p8 JWT). P0 stub: no live send until the 9-D wave. */
export class ApnsAdapter implements PushAdapter {
  constructor(private readonly configured: boolean) {}
  async send(): Promise<SendResult> {
    if (!this.configured) return "failed"; // no creds in P0 -> audited, never crashes
    // TODO(9-D): POST https://api.push.apple.com/3/device/<token> with p8 JWT.
    return "failed";
  }
}

/** FCM HTTP v1 (service account). P0 stub: no live send until the 9-D wave. */
export class FcmAdapter implements PushAdapter {
  constructor(private readonly configured: boolean) {}
  async send(): Promise<SendResult> {
    if (!this.configured) return "failed";
    // TODO(9-D): POST https://fcm.googleapis.com/v1/projects/<id>/messages:send.
    return "failed";
  }
}
