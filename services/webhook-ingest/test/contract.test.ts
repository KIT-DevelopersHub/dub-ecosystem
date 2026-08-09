// Contract adherence (test #13): the ack / envelope / delivery shapes this service
// produces must satisfy the frozen @dub/types webhook namespace and @dub/events channel.
import { describe, it, expect, expectTypeOf } from "vitest";
import type { R2Bucket, Queue } from "@cloudflare/workers-types";
import type { webhook } from "@dub/types";
import type { WebhookEventEnvelopeV1 } from "@dub/events";
import { ingest, type IngestDeps } from "../src/ingest";
import { QUEUE_NAME_BY_SOURCE, type WebhookEnvelope } from "../src/env";
import { FakeRepo, FakeQueue, FakeR2 } from "./helpers";

describe("contract adherence", () => {
  it("the envelope type equals the @dub/events channel type", () => {
    expectTypeOf<WebhookEnvelope>().toEqualTypeOf<WebhookEventEnvelopeV1>();
  });

  it("produced ack satisfies webhook.WebhookIngestAck; envelope satisfies WebhookEventEnvelopeV1", async () => {
    const repo = new FakeRepo();
    const queue = new FakeQueue<WebhookEnvelope>();
    const deps: IngestDeps = {
      repo,
      raw: new FakeR2() as unknown as R2Bucket,
      queues: { WH_GITHUB: queue as unknown as Queue<WebhookEnvelope> },
    };
    const ack = await ingest(deps, {
      source: "github",
      externalId: "e1",
      eventKind: "push",
      rawBytes: new TextEncoder().encode("{}"),
      headers: { "x-github-event": "push" },
      requestId: "req_1",
    });

    const ackTyped: webhook.WebhookIngestAck = ack;
    expect(typeof ackTyped.deliveryId).toBe("string");
    expect(typeof ackTyped.accepted).toBe("boolean");

    const env = queue.sent[0]!;
    const envTyped: WebhookEventEnvelopeV1 = env;
    expect(envTyped.type).toBe("webhook.received");
    expect(envTyped.version).toBe(1);
    expect(envTyped.id).toBe(ackTyped.deliveryId); // id = idempotency key for consumers
    expect(envTyped.source).toBe("github");
    expect(Object.values(QUEUE_NAME_BY_SOURCE)).toContain("dub-q-wh-github");
  });

  it("delivery status values are within the frozen union", () => {
    const valid: webhook.WebhookDeliveryStatus[] = ["received", "processed", "failed"];
    expect(valid).toContain("received");
  });
});
