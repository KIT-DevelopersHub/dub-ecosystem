import { describe, it, expect } from "vitest";
import type { mobile } from "@dub/types";
import type { DeviceRecord } from "../src/devices";
import { dispatchPush, type PushDeps, type PushRetryPolicy, type SendResult } from "../src/push";
import { MemoryDeviceStore, MemoryDeliveryStore, FakePushAdapter, AuditSink, ALICE } from "./helpers";

const CTX = { requestId: "req_1", userId: ALICE };
const PAYLOAD: mobile.MobilePushPayload = { title: "t", body: "b" };

function pushDeps(
  devices: MemoryDeviceStore,
  deliveries: MemoryDeliveryStore,
  ios: FakePushAdapter,
  android: FakePushAdapter,
  audit: AuditSink,
  retry?: PushRetryPolicy,
): PushDeps {
  return { devices, deliveries, adapters: { ios, android }, audit: audit.fn, orgId: "org_devhub", retry };
}

/** Adapter whose send() returns a scripted sequence of outcomes (for retry tests). */
class ScriptedAdapter extends FakePushAdapter {
  private i = 0;
  constructor(private readonly script: SendResult[]) {
    super();
  }
  override async send(device: DeviceRecord, payload: mobile.MobilePushPayload): Promise<SendResult> {
    this.sends.push({ deviceId: device.id, payload });
    return this.script[Math.min(this.i++, this.script.length - 1)]!;
  }
}

const NO_WAIT: PushRetryPolicy = { maxAttempts: 3, sleep: async () => {} };

describe("dispatchPush", () => {
  it("sends to every active device and records deliveries as sent", async () => {
    const devices = new MemoryDeviceStore();
    await devices.upsertByToken({ userId: ALICE, platform: "ios", pushToken: "a" });
    await devices.upsertByToken({ userId: ALICE, platform: "android", pushToken: "b" });
    const deliveries = new MemoryDeliveryStore();
    const ios = new FakePushAdapter();
    const android = new FakePushAdapter();
    const audit = new AuditSink();

    const res = await dispatchPush(pushDeps(devices, deliveries, ios, android, audit), CTX, "ntf_1", {
      userId: ALICE,
      type: "task.assigned",
      payload: PAYLOAD,
    });

    expect(res).toEqual({ accepted: true, deviceCount: 2 });
    expect(ios.sends).toHaveLength(1);
    expect(android.sends).toHaveLength(1);
    expect(deliveries.records.every((r) => r.status === "sent")).toBe(true);
  });

  it("token_invalid disables the device and does not audit-fail", async () => {
    const devices = new MemoryDeviceStore();
    const { device } = await devices.upsertByToken({ userId: ALICE, platform: "ios", pushToken: "a" });
    const deliveries = new MemoryDeliveryStore();
    const ios = new FakePushAdapter();
    ios.result = "token_invalid";
    const audit = new AuditSink();

    await dispatchPush(pushDeps(devices, deliveries, ios, new FakePushAdapter(), audit), CTX, "ntf_1", {
      userId: ALICE,
      type: "task.assigned",
      payload: PAYLOAD,
    });

    expect((await devices.getById(device.id))?.disabledAt).not.toBeNull();
    expect(deliveries.records[0]?.status).toBe("token_invalid");
    expect(audit.records).toHaveLength(0); // invalid token is auto-cleanup, not a failure
    expect(await devices.listActiveByUser(ALICE)).toHaveLength(0);
  });

  it("hard failure marks failed and emits a publishAudit failure record", async () => {
    const devices = new MemoryDeviceStore();
    await devices.upsertByToken({ userId: ALICE, platform: "ios", pushToken: "a" });
    const deliveries = new MemoryDeliveryStore();
    const ios = new FakePushAdapter();
    ios.throwErr = new Error("apns 500");
    const audit = new AuditSink();

    await dispatchPush(pushDeps(devices, deliveries, ios, new FakePushAdapter(), audit), CTX, "ntf_9", {
      userId: ALICE,
      type: "task.assigned",
      payload: PAYLOAD,
    });

    expect(deliveries.records[0]?.status).toBe("failed");
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      action: "mobile.push.delivery_failed",
      result: "failure",
      resourceId: "ntf_9",
    });
  });

  it("retries a hard failure and succeeds within maxAttempts (records the real attempt count)", async () => {
    const devices = new MemoryDeviceStore();
    await devices.upsertByToken({ userId: ALICE, platform: "ios", pushToken: "a" });
    const deliveries = new MemoryDeliveryStore();
    const ios = new ScriptedAdapter(["failed", "failed", "sent"]); // 3rd attempt lands
    const audit = new AuditSink();

    await dispatchPush(pushDeps(devices, deliveries, ios, new FakePushAdapter(), audit, NO_WAIT), CTX, "ntf_1", {
      userId: ALICE,
      type: "task.assigned",
      payload: PAYLOAD,
    });

    expect(ios.sends).toHaveLength(3);
    expect(deliveries.records[0]?.status).toBe("sent");
    expect(deliveries.records[0]?.attempts).toBe(3);
    expect(audit.records).toHaveLength(0); // eventual success is not a failure
  });

  it("exhausts attempts then marks failed and audits once with the attempt count", async () => {
    const devices = new MemoryDeviceStore();
    await devices.upsertByToken({ userId: ALICE, platform: "ios", pushToken: "a" });
    const deliveries = new MemoryDeliveryStore();
    const ios = new FakePushAdapter();
    ios.result = "failed";
    const audit = new AuditSink();

    await dispatchPush(pushDeps(devices, deliveries, ios, new FakePushAdapter(), audit, { maxAttempts: 2, sleep: async () => {} }), CTX, "ntf_9", {
      userId: ALICE,
      type: "task.assigned",
      payload: PAYLOAD,
    });

    expect(ios.sends).toHaveLength(2);
    expect(deliveries.records[0]?.status).toBe("failed");
    expect(deliveries.records[0]?.attempts).toBe(2);
    expect(audit.records).toHaveLength(1);
    expect((audit.records[0]?.details as { attempts: number }).attempts).toBe(2);
  });

  it("does not retry a token_invalid (terminal): one attempt, device disabled", async () => {
    const devices = new MemoryDeviceStore();
    const { device } = await devices.upsertByToken({ userId: ALICE, platform: "ios", pushToken: "a" });
    const deliveries = new MemoryDeliveryStore();
    const ios = new ScriptedAdapter(["token_invalid", "sent"]); // would succeed on retry, but must not retry
    const audit = new AuditSink();

    await dispatchPush(pushDeps(devices, deliveries, ios, new FakePushAdapter(), audit, NO_WAIT), CTX, "ntf_2", {
      userId: ALICE,
      type: "task.assigned",
      payload: PAYLOAD,
    });

    expect(ios.sends).toHaveLength(1); // terminal, no retry
    expect(deliveries.records[0]?.status).toBe("token_invalid");
    expect((await devices.getById(device.id))?.disabledAt).not.toBeNull();
  });

  it("empty device set returns deviceCount 0 without error", async () => {
    const res = await dispatchPush(
      pushDeps(new MemoryDeviceStore(), new MemoryDeliveryStore(), new FakePushAdapter(), new FakePushAdapter(), new AuditSink()),
      CTX,
      "ntf_1",
      { userId: "usr_nobody", type: "task.assigned", payload: PAYLOAD },
    );
    expect(res).toEqual({ accepted: true, deviceCount: 0 });
  });
});
