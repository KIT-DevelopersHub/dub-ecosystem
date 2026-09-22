// Guards the identity port's outbound contract. Role → user-id expansion MUST target
// the internal S2S route GET /internal/users (x-dub-internal gated), NOT the bare
// GET /users (no list handler → 404) nor the permission-gated GET /identity/users.
// Regression for: feedback → admin inbox notifications silently failing because the
// role fan-out call 404'd and was swallowed as best-effort.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { makeIdentityPort, makePushPort } from "../src/clients";
import { ctx } from "./helpers";

// Records the path + query of every request and answers role expansion with a page.
function recordingIdentity(): { binding: Fetcher; paths: string[] } {
  const paths: string[] = [];
  const binding = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      paths.push(url.pathname + url.search);
      const body = { items: [{ id: "usr_admin1" }, { id: "usr_admin2" }], nextCursor: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
  return { binding, paths };
}

describe("makeIdentityPort.listUserIdsByRole", () => {
  it("calls the internal S2S route /internal/users?roleKey= and maps ids", async () => {
    const { binding, paths } = recordingIdentity();
    const port = makeIdentityPort(binding);
    const ids = await port.listUserIdsByRole("role_sys_admin", ctx());
    expect(ids).toEqual(["usr_admin1", "usr_admin2"]);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/internal/users?roleKey=role_sys_admin");
    // never the bare /users (404s) or the permission-gated /identity/users
    expect(paths[0]!.startsWith("/internal/users")).toBe(true);
  });
});

// Records the request path + parsed JSON body of every call.
function recordingBff(): { binding: Fetcher; calls: { path: string; body: unknown }[] } {
  const calls: { path: string; body: unknown }[] = [];
  const binding = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const body = await req.json().catch(() => undefined);
      calls.push({ path: url.pathname, body });
      return new Response(JSON.stringify({ accepted: true, deviceCount: 1 }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Fetcher;
  return { binding, calls };
}

describe("makePushPort.dispatch", () => {
  it("POSTs /internal/push/dispatch with the nested mobile.PushDispatchRequest shape", async () => {
    const { binding, calls } = recordingBff();
    const port = makePushPort(binding);
    await port.dispatch(
      {
        userId: "u1",
        type: "task.assigned",
        notificationId: "ntf_1",
        title: "Assigned",
        body: "to you",
        data: { notificationId: "ntf_1", deepLink: "dub://tasks/tsk_9" },
      },
      ctx(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/internal/push/dispatch");
    // mo3 requires payload:{title,body,data}; notificationId travels off-wire top-level.
    expect(calls[0]!.body).toEqual({
      userId: "u1",
      type: "task.assigned",
      notificationId: "ntf_1",
      payload: {
        title: "Assigned",
        body: "to you",
        data: { notificationId: "ntf_1", deepLink: "dub://tasks/tsk_9" },
      },
    });
  });

  it("coerces a null body to '' (MobilePushPayload.body is a required string)", async () => {
    const { binding, calls } = recordingBff();
    const port = makePushPort(binding);
    await port.dispatch(
      { userId: "u1", type: "x.y", notificationId: "ntf_2", title: "T", body: null, data: { notificationId: "ntf_2" } },
      ctx(),
    );
    expect((calls[0]!.body as { payload: { body: string } }).payload.body).toBe("");
  });
});
