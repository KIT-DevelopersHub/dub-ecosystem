// Receive audiences (ロール管理 > 通知): 管理者向け / 全体 recipients are whoever's roles hold
// notif:receive_admin / notif:receive_all — fan-out, inbox visibility, the /notify contract
// and the 通知管理「誰に届くか」 summary.
import { describe, it, expect } from "vitest";
import type { notification } from "@dub/types";
import { createApp } from "../src/app";
import { insertNotification } from "../src/repo";
import { parseNotifyRequest } from "../src/validation";
import { unreadCount } from "../src/repo";
import type { IngestInput } from "../src/types";
import { makeTestEnv, fakeIdentity, fakeAuthzFetcher, NOTIF_ADMIN_KEYS, type TestEnvHandle } from "./helpers";

const BASE_KEYS = ["app:notifications:view", "notif:inbox:self", "notif:prefs:self"] as const;

function reqOf(app: ReturnType<typeof createApp>, h: TestEnvHandle) {
  return (path: string, init: RequestInit = {}) => app.request(path, init, h.env as unknown as Record<string, unknown>);
}
const as = (userId: string): RequestInit => ({ headers: { "x-dub-user-id": userId } });
const internalPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-dub-internal": "1" },
  body: JSON.stringify(body),
});

function row(over: Partial<IngestInput>): IngestInput {
  return {
    type: "deploy.completed",
    recipients: { userIds: [] },
    title: "デプロイ完了",
    body: "",
    priority: "normal",
    audience: "admin",
    source: "api",
    actorId: null,
    requestId: "req_test",
    ...over,
  };
}

describe("inbox visibility follows the receive keys, not notif:admin", () => {
  it("a role with notif:receive_admin (and no notif:admin) sees admin rows; notif:admin alone does not", async () => {
    const h = makeTestEnv({
      SVC_IDENTITY: fakeAuthzFetcher((u) =>
        u === "usr_ops" ? [...BASE_KEYS, "notif:receive_admin"] : u === "usr_legacy" ? [...BASE_KEYS, "notif:admin"] : BASE_KEYS,
      ),
    });
    const req = reqOf(createApp(), h);
    await insertNotification(h.db, row({ dedupKey: "deploy:1" }));

    const ops = (await (await req("/inbox", as("usr_ops"))).json()) as notification.ListInboxResponse;
    expect(ops.items.map((i) => i.title)).toEqual(["デプロイ完了"]);
    const legacy = (await (await req("/inbox", as("usr_legacy"))).json()) as notification.ListInboxResponse;
    expect(legacy.items).toHaveLength(0);
  });

  it("broadcasts backfill only to notif:receive_all holders", async () => {
    const h = makeTestEnv({
      SVC_IDENTITY: fakeAuthzFetcher((u) => (u === "usr_all" ? [...BASE_KEYS, "notif:receive_all"] : BASE_KEYS)),
    });
    const req = reqOf(createApp(), h);
    await insertNotification(h.db, row({ type: "release", audience: "members", title: "新機能", dedupKey: "release:x" }));

    expect(((await (await req("/inbox/unread-count", as("usr_all"))).json()) as { count: number }).count).toBe(1);
    expect(((await (await req("/inbox/unread-count", as("usr_none"))).json()) as { count: number }).count).toBe(0);
  });
});

describe("POST /notify recipientAudiences", () => {
  it("fans an admin alert out to the notif:receive_admin holders", async () => {
    const h = makeTestEnv();
    const identity = fakeIdentity({ byPermission: { "notif:receive_admin": ["u_admin", "u_ops"] } });
    const res = await reqOf(createApp({ identity }), h)(
      "/notify",
      internalPost({ type: "health.alert", recipientIds: [], recipientAudiences: ["admin"], title: "落ちた", body: "x", channels: ["in_app"] }),
    );
    expect(res.status).toBe(202);
    expect(await unreadCount(h.db, "u_admin")).toBe(1);
    expect(await unreadCount(h.db, "u_ops")).toBe(1);
    expect(identity.permissionCalls).toEqual(["notif:receive_admin"]);
  });

  it("validates the audience vocabulary and counts it as a recipient source", () => {
    const base = { type: "x.y", title: "t", body: "b" };
    expect(parseNotifyRequest({ ...base, recipientIds: [], recipientAudiences: ["admin", "admin"] }).recipientAudiences).toEqual(["admin"]);
    expect(() => parseNotifyRequest({ ...base, recipientIds: [], recipientAudiences: ["owners"] })).toThrow();
    expect(() => parseNotifyRequest({ ...base, recipientIds: [], recipientAudiences: [] })).toThrow();
  });
});

describe("GET /notifications/audiences (誰に届くか)", () => {
  it("returns each audience with the roles holding its key and the recipient count", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: fakeAuthzFetcher((u) => (u === "usr_admin" ? NOTIF_ADMIN_KEYS : BASE_KEYS)) });
    const identity = fakeIdentity({
      byPermission: { "notif:receive_admin": ["u1", "u2"], "notif:receive_all": ["u1", "u2", "u3"] },
      rolesByPermission: {
        "notif:receive_admin": [{ id: "role_sys_admin", name: "admin", memberCount: 1 }, { id: "role_sys_maintainer", name: "maintainer", memberCount: 1 }],
        "notif:receive_all": [{ id: "role_sys_member", name: "member", memberCount: 3 }],
      },
    });
    const req = reqOf(createApp({ identity }), h);
    const res = await req("/notifications/audiences", as("usr_admin"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as notification.ListAudiencesResponse;
    expect(body.items.map((i) => [i.audience, i.permission, i.recipientCount])).toEqual([
      ["all", "notif:receive_all", 3],
      ["admin", "notif:receive_admin", 2],
    ]);
    expect(body.items[1]!.label).toBe("管理者向け通知を受け取る");
    expect(body.items[1]!.roles.map((r) => r.name)).toEqual(["admin", "maintainer"]);
  });

  it("is gated like the management list (403 without notif:broadcast_publish)", async () => {
    const h = makeTestEnv();
    const res = await reqOf(createApp({ identity: fakeIdentity({}) }), h)("/notifications/audiences", as("usr_member"));
    expect(res.status).toBe(403);
  });
});
