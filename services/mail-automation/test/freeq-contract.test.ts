// #836 contract between producer (mail-gateway's mail.message.received envelope on the shared
// freeq outbox), transport (freeq-drain makeDeliver) and this consumer. Prod 400'd every row
// because the deployed build predated /internal/events-async; this pins that the exact request
// the drain sends, carrying a real prod envelope shape, is accepted by the current app, and
// that what this service publishes back lands on topics the drain delivers.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { createEvent } from "@dub/events";
import { createApp } from "../src/app";
import { NOTIFICATION_TOPIC, AUDIT_TOPIC } from "../src/outbox";
import { makeDeliver, routeFor } from "../../freeq-drain/src/routing";
import { makeDeps, inbound, granter } from "./fakes";

describe("freeq-drain -> mail-automation /internal/events-async (#836)", () => {
  it("delivers a drained mail.message.received and runs the pipeline (was 400 in prod)", async () => {
    const b = makeDeps({ messages: { "<m@x>": inbound({ messageId: "<m@x>", threadId: "<m@x>" }) } });
    const app = createApp({ pipeline: b.deps, authz: granter("none") });
    const SVC_MAIL_AUTOMATION = { fetch: (u: string, init: RequestInit) => app.request(u, init) } as unknown as Fetcher;
    // Same constructor mail-gateway uses, actorId null (system origin) like the prod rows.
    const envelope = createEvent("mail.message.received", { messageId: "<m@x>", threadId: "<m@x>" }, { requestId: "01M89HVW4QPGFAP8589YJQT581", actorId: null });

    await expect(makeDeliver({ SVC_MAIL_AUTOMATION } as never)({ topic: "evt.mail-automation", payload: envelope } as never)).resolves.toBeUndefined();
    expect(b.publisher.decided).toHaveLength(1);
  });

  it("publishes back only on topics freeq-drain delivers", () => {
    expect(routeFor(NOTIFICATION_TOPIC).kind).toBe("deliver");
    expect(routeFor(AUDIT_TOPIC).kind).toBe("deliver");
  });
});
