// The s2s contract with lp-tickets: path, x-dub-internal, the acting user, and errors that surface.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { createTicketReleaseClient } from "../src/ticket-release";

function binding(handler: (req: Request) => Response) {
  const seen: Request[] = [];
  const fetcher = {
    fetch: async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seen.push(req.clone());
      return handler(req);
    },
  } as unknown as Fetcher;
  return { fetcher, seen };
}

const OK = { ticketsEnabled: true, ticketsCtaEnabled: false };
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("createTicketReleaseClient", () => {
  it("reads over the INTERNAL route", async () => {
    const { fetcher, seen } = binding(() => json(200, OK));
    expect(await createTicketReleaseClient(fetcher, "req_1").get()).toEqual(OK);
    expect(new URL(seen[0]!.url).pathname).toBe("/lp/internal/tickets/release");
    expect(seen[0]!.headers.get("x-dub-internal")).toBeTruthy();
    expect(seen[0]!.headers.get("x-dub-request-id")).toBe("req_1");
  });

  it("writes with the acting user", async () => {
    const { fetcher, seen } = binding(() => json(200, OK));
    await createTicketReleaseClient(fetcher, "req_1").set(OK, "usr_admin");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.get("x-dub-user-id")).toBe("usr_admin");
    expect(await seen[0]!.json()).toEqual(OK);
  });

  it("throws when lp-tickets refuses (never a silent default)", async () => {
    const { fetcher } = binding(() => json(403, { error: { code: "FORBIDDEN", message: "no", retryable: false } }));
    await expect(createTicketReleaseClient(fetcher, "req_1").get()).rejects.toThrow();
  });
});
