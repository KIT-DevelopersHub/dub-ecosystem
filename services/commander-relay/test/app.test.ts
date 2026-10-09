// Route coverage + runtime authz for the HTTP surface, and the Worker entry's gating of the
// header-trusting API (svc host only) and the agent socket (bearer secret).
import { describe, expect, it } from "vitest";
import { checkRouteCoverage, type PermissionGranter } from "@dub/policy-gate";
import { HDR_USER_ID } from "@dub/observability";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { signTicket, verifyTicket } from "../src/ticket";
import worker from "../src/index";
import type { Env } from "../src/env";

const allowAll: PermissionGranter = async (_u, _o, requested) => [...requested];
const holding =
  (...keys: string[]): PermissionGranter =>
  async (_u, _o, requested) =>
    requested.filter((k) => keys.includes(k));

const ENV: Env = {
  RELAY_TICKET_SECRET: "ticket-secret",
  RELAY_AGENT_SECRET: "agent-secret",
  RELAY_WS_URL: "wss://relay.example/ws/browser",
  RELAY_ALLOWED_ORIGINS: "https://app.example",
  COMMANDER_OWNER_USER_IDS: "user_owner",
};

function post(app: ReturnType<typeof createApp>, env: Env, headers: Record<string, string> = { [HDR_USER_ID]: "user_owner" }) {
  return app.request("https://svc/commander/relay/ticket", { method: "POST", headers }, env);
}

describe("route coverage", () => {
  it("every route has exactly one rule", () => {
    expect(checkRouteCoverage(createApp({ authz: allowAll }), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
  });
});

describe("POST /commander/relay/ticket", () => {
  it("401 without a user, 403 without app:commander:edit", async () => {
    expect((await post(createApp({ authz: allowAll }), ENV, {})).status).toBe(401);
    expect((await post(createApp({ authz: holding("app:commander:view") }), ENV)).status).toBe(403);
  });

  it("mints a ticket the DO will accept, plus the wss URL", async () => {
    const res = await post(createApp({ authz: allowAll }), ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; wsUrl: string };
    expect(body.wsUrl).toBe(ENV.RELAY_WS_URL);
    expect(await verifyTicket("ticket-secret", body.ticket)).toMatchObject({ userId: "user_owner" });
  });

  it("owner allow-list narrows editors to the PC's owner", async () => {
    const env = { ...ENV, COMMANDER_OWNER_USER_IDS: "user_owner, user_alt" };
    expect((await post(createApp({ authz: allowAll }), env)).status).toBe(200);
    expect((await post(createApp({ authz: allowAll }), env, { [HDR_USER_ID]: "user_other_admin" })).status).toBe(403);
  });

  it("no owner configured means nobody, not every editor", async () => {
    expect((await post(createApp({ authz: allowAll }), { ...ENV, COMMANDER_OWNER_USER_IDS: "" })).status).toBe(503);
  });

  it("fails closed when secrets are not configured", async () => {
    expect((await post(createApp({ authz: allowAll }), {})).status).toBe(503);
  });
});

describe("Worker entry", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

  it("hides the header-trusting API from the public host", async () => {
    const res = await worker.fetch(
      new Request("https://dub-commander-relay.example.workers.dev/commander/relay/ticket", {
        method: "POST",
        headers: { [HDR_USER_ID]: "spoofed" },
      }),
      ENV,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("refuses an agent socket without the exact bearer secret, before touching the DO", async () => {
    let doCalls = 0;
    const env: Env = {
      ...ENV,
      RELAY: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => (doCalls++, new Response("ok")) }),
      } as never,
    };
    const upgrade = (auth?: string) =>
      new Request("https://relay.example/ws/agent", {
        headers: { Upgrade: "websocket", ...(auth ? { Authorization: auth } : {}) },
      });
    expect((await worker.fetch(upgrade(), env, ctx)).status).toBe(401);
    expect((await worker.fetch(upgrade("Bearer wrong"), env, ctx)).status).toBe(401);
    expect((await worker.fetch(upgrade("Bearer agent-secret"), { ...env, RELAY_AGENT_SECRET: "" }, ctx)).status).toBe(401);
    expect(doCalls).toBe(0);
    expect((await worker.fetch(upgrade("Bearer agent-secret"), env, ctx)).status).toBe(200);
    expect(doCalls).toBe(1);
  });

  it("rejects browser upgrades with a bad Origin or ticket before waking the DO", async () => {
    let doCalls = 0;
    const env: Env = {
      ...ENV,
      RELAY: { idFromName: () => ({}), get: () => ({ fetch: async () => (doCalls++, new Response("ok")) }) } as never,
    };
    const good = await signTicket("ticket-secret", "user_owner");
    const upgrade = (ticket: string, origin: string) =>
      new Request(`https://relay.example/ws/browser?ticket=${ticket}`, { headers: { Upgrade: "websocket", Origin: origin } });
    expect((await worker.fetch(upgrade(good, "https://evil.example"), env, ctx)).status).toBe(403);
    expect((await worker.fetch(upgrade("x.y", "https://app.example"), env, ctx)).status).toBe(401);
    expect(doCalls).toBe(0);
    expect((await worker.fetch(upgrade(good, "https://app.example"), env, ctx)).status).toBe(200);
    expect(doCalls).toBe(1);
  });
});
