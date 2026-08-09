import { describe, it, expect } from "vitest";
import type { R2Bucket, Queue } from "@cloudflare/workers-types";
import { ingest, type IngestDeps, type VerifiedRequest } from "../src/ingest";
import { cleanup } from "../src/cleanup";
import { OFFLOAD_THRESHOLD_BYTES } from "../src/env";
import { FakeRepo, FakeQueue, FakeR2 } from "./helpers";
import type { WebhookEnvelope } from "../src/env";

function makeDeps(): { deps: IngestDeps; repo: FakeRepo; queue: FakeQueue<WebhookEnvelope>; r2: FakeR2 } {
  const repo = new FakeRepo();
  const queue = new FakeQueue<WebhookEnvelope>();
  const r2 = new FakeR2();
  const deps: IngestDeps = {
    repo,
    raw: r2 as unknown as R2Bucket,
    queues: { WH_GITHUB: queue as unknown as Queue<WebhookEnvelope> },
  };
  return { deps, repo, queue, r2 };
}

function req(over: Partial<VerifiedRequest> = {}): VerifiedRequest {
  return {
    source: "github",
    externalId: "delivery-1",
    eventKind: "push",
    rawBytes: new TextEncoder().encode(JSON.stringify({ hello: "world" })),
    headers: { "x-github-event": "push" },
    requestId: "req_test",
    ...over,
  };
}

describe("ingest core", () => {
  it("publishes a new delivery and persists one row (test #1)", async () => {
    const { deps, repo, queue } = makeDeps();
    const ack = await ingest(deps, req());
    expect(ack.accepted).toBe(true);
    expect(queue.sent).toHaveLength(1);
    expect(repo.rows.size).toBe(1);
    const env = queue.sent[0]!;
    expect(env.type).toBe("webhook.received");
    expect(env.id).toBe(ack.deliveryId);
    expect(env.payload).toEqual({ hello: "world" });
    expect(env.r2Key).toBeNull();
  });

  it("dedups a repeat delivery: second is accepted:false, publish stays at 1 (test #3)", async () => {
    const { deps, queue } = makeDeps();
    const first = await ingest(deps, req());
    const second = await ingest(deps, req());
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.deliveryId).toBe(first.deliveryId); // returns the existing row id
    expect(queue.sent).toHaveLength(1);
  });

  it("offloads a >96KB body to R2 with payload=null + r2Key set (test #6)", async () => {
    const { deps, queue, r2 } = makeDeps();
    const big = JSON.stringify({ blob: "x".repeat(OFFLOAD_THRESHOLD_BYTES + 100) });
    const ack = await ingest(deps, req({ rawBytes: new TextEncoder().encode(big) }));
    const env = queue.sent[0]!;
    expect(env.payload).toBeNull();
    expect(env.r2Key).toBe(`webhook-raw/github/${ack.deliveryId}`);
    expect(r2.store.has(env.r2Key!)).toBe(true);
  });

  it("rolls back the dedup row when publish fails (test #7)", async () => {
    const { deps, repo, queue } = makeDeps();
    queue.failNext = true;
    await expect(ingest(deps, req())).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
    expect(repo.rows.size).toBe(0); // row removed -> sender can retry successfully
    queue.failNext = false;
    const retry = await ingest(deps, req());
    expect(retry.accepted).toBe(true);
    expect(queue.sent).toHaveLength(1);
  });

  it("rolls back the R2 object too when publish fails after offload", async () => {
    const { deps, repo, queue, r2 } = makeDeps();
    const big = JSON.stringify({ blob: "y".repeat(OFFLOAD_THRESHOLD_BYTES + 100) });
    queue.failNext = true;
    await expect(ingest(deps, req({ rawBytes: new TextEncoder().encode(big) }))).rejects.toBeTruthy();
    expect(repo.rows.size).toBe(0);
    expect(r2.store.size).toBe(0);
  });
});

describe("retention cleanup (test #10)", () => {
  it("purges rows + R2 objects older than the window and keeps recent ones", async () => {
    const { deps, repo, r2 } = makeDeps();
    const nowMs = Date.parse("2026-08-09T00:00:00Z");

    // old row (40 days ago) with an R2 object
    await repo.insertIfNew({
      id: "wh_old", source: "github", externalId: "old", eventKind: "push", status: "received",
      queue: "dub-q-wh-github", r2Key: "webhook-raw/github/wh_old", bodySize: 10,
      receivedAt: new Date(nowMs - 40 * 86400_000).toISOString(), processedAt: null, requestId: "r",
    });
    await r2.put("webhook-raw/github/wh_old", "old-body");
    // recent row (1 day ago)
    await repo.insertIfNew({
      id: "wh_new", source: "github", externalId: "new", eventKind: "push", status: "received",
      queue: "dub-q-wh-github", r2Key: null, bodySize: 10,
      receivedAt: new Date(nowMs - 1 * 86400_000).toISOString(), processedAt: null, requestId: "r",
    });

    const res = await cleanup({ repo, raw: r2 as unknown as R2Bucket, now: () => nowMs }, 30);
    expect(res.deletedRows).toBe(1);
    expect(res.deletedObjects).toBe(1);
    expect(repo.rows.has("wh_new")).toBe(true);
    expect(repo.rows.has("wh_old")).toBe(false);
    expect(r2.store.has("webhook-raw/github/wh_old")).toBe(false);
  });
});
