// Cron backstop for the freeq-drain alarm loop: every mail-gateway */5 tick kicks the
// idempotent /internal/drain/kick. It must carry the internal marker (freeq-drain's policy
// table is INTERNAL-only), and must never throw into the mail cron.
import { describe, it, expect } from "vitest";
import type { ExecutionContext, Fetcher, ScheduledController } from "@cloudflare/workers-types";
import { HDR_INTERNAL } from "@dub/observability";
import { FREEQ_KICK_URL, kickFreeqDrain } from "../src/freeq-kick";
import handler from "../src/index";
import { makeEnv } from "./helpers";

function svc(impl: (url: string, init: RequestInit) => Promise<Response>): { svc: Fetcher; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    svc: {
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return impl(url, init);
      },
    } as unknown as Fetcher,
  };
}

describe("kickFreeqDrain (freeq-drain alarm backstop)", () => {
  it("POSTs the kick with the x-dub-internal marker", async () => {
    const s = svc(async () => new Response("{}", { status: 200 }));
    expect(await kickFreeqDrain({ SVC_FREEQ_DRAIN: s.svc })).toBe("kicked");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(FREEQ_KICK_URL);
    expect(s.calls[0]!.init.method).toBe("POST");
    expect((s.calls[0]!.init.headers as Record<string, string>)[HDR_INTERNAL]).toBeTruthy();
  });

  it("is a no-op without the binding", async () => {
    expect(await kickFreeqDrain({})).toBe("no_binding");
  });

  it("never throws: a down freeq-drain or a non-2xx is reported, not raised", async () => {
    const down = svc(async () => {
      throw new Error("connection refused");
    });
    expect(await kickFreeqDrain({ SVC_FREEQ_DRAIN: down.svc })).toBe("failed");
    const forbidden = svc(async () => new Response("", { status: 403 }));
    expect(await kickFreeqDrain({ SVC_FREEQ_DRAIN: forbidden.svc })).toBe("failed");
  });
});

describe("scheduled() wires the backstop", () => {
  it("every cron tick kicks freeq-drain (via waitUntil, off the mail critical path)", async () => {
    const s = svc(async () => new Response("{}", { status: 200 }));
    const { env } = makeEnv({ SVC_FREEQ_DRAIN: s.svc } as never);
    const waited: Promise<unknown>[] = [];
    const execCtx = { waitUntil: (p: Promise<unknown>) => void waited.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const controller = { scheduledTime: Date.UTC(2026, 10, 25, 3, 5), cron: "*/5 * * * *", noRetry() {} } as unknown as ScheduledController;

    await handler.scheduled(controller, env, execCtx);
    await Promise.all(waited);

    expect(s.calls.map((c) => c.url)).toEqual([FREEQ_KICK_URL]);
  });
});
