// Demo transport (backend-free showcase). Verifies createDemoFetch auto-logs-in
// with a broad permission session and serves each feature's primary list/detail
// endpoint from seed data, driven end-to-end through the REAL api-client (so the
// mock exercises retry/refresh/error handling, not a bypass). Unknown routes
// still fall through to a NOT_FOUND envelope (in-frame fallback, never blank).
import { describe, expect, it } from "vitest";
import { createApiClient, ApiError } from "./api-client.tsx";
import { createDemoFetch, isDemoEnabled } from "./demo-seed.tsx";

function api() {
  return createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() });
}

describe("createDemoFetch", () => {
  it("auto-completes login with a broad-permission session", async () => {
    const me = await api().auth.me();
    expect(me.user.displayName).toBe("デモ 管理者");
    expect(me.permissions).toContain("mail:send");
    expect(me.permissions).toContain("identity:admin");
  });

  it("serves seeded feature lists so every nav item renders data", async () => {
    const a = api();
    const events = await a.events.get<{ items: unknown[] }>("");
    expect(events.items.length).toBeGreaterThan(0);
    const tasks = await a.tasks.get<{ items: unknown[] }>("");
    expect(tasks.items.length).toBeGreaterThan(0);
    const inbox = await a.notifications.get<{ items: unknown[] }>("/inbox");
    expect(inbox.items.length).toBeGreaterThan(0);
    const mail = await a.request<{ items: unknown[] }>({ method: "GET", path: "/api/v1/mail/messages" });
    expect(mail.items.length).toBeGreaterThan(0);
    const users = await a.identity.get<{ items: unknown[] }>("/users");
    expect(users.items.length).toBeGreaterThan(0);
  });

  it("serves detail + benign mutation endpoints (mail read/thread, gantt)", async () => {
    const a = api();
    const thread = await a.request<{ id: string; messages: unknown[] }>({ method: "GET", path: "/api/v1/mail/threads/thr_1" });
    expect(thread.messages.length).toBeGreaterThan(0);
    const read = await a.request<{ read: boolean }>({ method: "POST", path: "/api/v1/mail/messages/msg_1/read", body: {} });
    expect(read.read).toBe(true);
    const gantt = await a.request<{ rows: unknown[] }>({ method: "GET", path: "/api/v1/gantt", query: { event: "evt_1" } });
    expect(gantt.rows.length).toBeGreaterThan(0);
  });

  it("persists an event edit (PATCH) so the save reflects on re-read", async () => {
    const a = api();
    const before = await a.request<{ version: number; title: string }>({ method: "GET", path: "/api/v1/events/evt_1" });
    const updated = await a.request<{ version: number; title: string; startsAt: string | null; description: string | null }>({
      method: "PATCH",
      path: "/api/v1/events/evt_1",
      body: { version: before.version, title: "編集済みイベント", startsAt: "2026-10-01T00:30:00.000Z", description: "更新後の説明" },
    });
    expect(updated.title).toBe("編集済みイベント");
    expect(updated.startsAt).toBe("2026-10-01T00:30:00.000Z");
    expect(updated.description).toBe("更新後の説明");
    expect(updated.version).toBe(before.version + 1);
    // re-read reflects the change (persisted in-memory), and the list summary is in sync
    const after = await a.request<{ title: string }>({ method: "GET", path: "/api/v1/events/evt_1" });
    expect(after.title).toBe("編集済みイベント");
  });

  it("still surfaces NOT_FOUND for un-seeded routes (in-frame fallback)", async () => {
    let caught: unknown;
    try {
      await api().request({ method: "GET", path: "/api/v1/unknown/thing" });
    } catch (e) {
      caught = e;
    }
    expect(ApiError.isApiError(caught)).toBe(true);
    expect((caught as ApiError).status).toBe(404);
  });
});

describe("event section layout (shared D&D order/visibility)", () => {
  it("GET returns the default empty layout for an event never saved to", async () => {
    const layout = await api().request<{ eventId: string; data: { order: string[]; hidden: string[] }; version: number }>(
      { method: "GET", path: "/api/v1/events/evt_layout_get/section-layout" },
    );
    expect(layout.data).toEqual({ order: [], hidden: [] });
    expect(layout.version).toBe(0);
  });

  it("PUT saves (v0 -> v1) and persists across a fresh api() instance (localStorage-backed)", async () => {
    const eventId = "evt_layout_persist";
    const saved = await api().request<{ data: { order: string[] }; version: number }>({
      method: "PUT",
      path: `/api/v1/events/${eventId}/section-layout`,
      body: { version: 0, data: { order: ["links", "contacts"], hidden: ["memo"] } },
    });
    expect(saved.version).toBe(1);
    expect(saved.data.order).toEqual(["links", "contacts"]);

    // A fresh api()/createDemoFetch() call simulates a reload: the in-memory session
    // resets, but the localStorage-backed layout must still read back.
    const reread = await api().request<{ data: { order: string[]; hidden: string[] }; version: number }>({
      method: "GET",
      path: `/api/v1/events/${eventId}/section-layout`,
    });
    expect(reread.version).toBe(1);
    expect(reread.data.order).toEqual(["links", "contacts"]);
    expect(reread.data.hidden).toEqual(["memo"]);
  });

  it("stale version PUT -> 409 EVENT_VERSION_CONFLICT", async () => {
    const eventId = "evt_layout_conflict";
    await api().request({
      method: "PUT",
      path: `/api/v1/events/${eventId}/section-layout`,
      body: { version: 0, data: { order: ["a"], hidden: [] } },
    });
    // second save must use version 1; sending 0 again conflicts (mirrors event-service).
    let caught: unknown;
    try {
      await api().request({
        method: "PUT",
        path: `/api/v1/events/${eventId}/section-layout`,
        body: { version: 0, data: { order: ["b"], hidden: [] } },
      });
    } catch (e) {
      caught = e;
    }
    expect(ApiError.isApiError(caught)).toBe(true);
    expect((caught as ApiError).status).toBe(409);
  });
});

describe("calendar meetings (カレンダー > ミーティング)", () => {
  interface Meeting { id: string; title: string; targetName: string; meetUrl: string | null; startsAt: string }
  interface List { items: Meeting[]; account: { email: string | null; calendarReady: boolean } }

  it("grants the demo admin the カレンダー app, 予定を登録 and both meeting keys", async () => {
    const me = await api().auth.me();
    for (const k of ["app:calendar:view", "app:calendar:edit", "calendar:schedule_edit", "calendar:meetings_view", "calendar:meetings_edit"]) {
      expect(me.permissions).toContain(k);
    }
  });

  it("serves seeded meetings + targets on a connected shared account", async () => {
    const a = api();
    const list = await a.request<List>({ method: "GET", path: "/api/v1/meetings" });
    expect(list.account).toEqual({ email: "hackit.dub@gmail.com", calendarReady: true });
    expect(list.items.map((m) => m.title)).toEqual(expect.arrayContaining(["全体定例", "統括定例"]));
    const targets = await a.request<{ items: { id: string; isMine: boolean }[] }>({ method: "GET", path: "/api/v1/meetings/targets" });
    expect(targets.items.filter((t) => t.isMine).map((t) => t.id)).toEqual(["all", "role_lead"]);
  });

  it("create → patch → delete round-trips in the session, with a fake Meet link", async () => {
    const a = api();
    const created = await a.request<Meeting>({
      method: "POST",
      path: "/api/v1/meetings",
      body: { title: "週次", targetId: "role_member", startsAt: "2026-10-19T12:00:00.000Z", durationMinutes: 60, recurrence: "weekly" },
    });
    expect(created.meetUrl).toMatch(/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    expect(created.targetName).toBe("member");
    const patched = await a.request<Meeting>({ method: "PATCH", path: `/api/v1/meetings/${created.id}`, body: { title: "週次MTG" } });
    expect(patched.title).toBe("週次MTG");
    await a.request({ method: "DELETE", path: `/api/v1/meetings/${created.id}` });
    const list = await a.request<List>({ method: "GET", path: "/api/v1/meetings" });
    expect(list.items.some((m) => m.id === created.id)).toBe(false);
    const sync = await a.request<{ withoutGoogleAccount: unknown[] }>({ method: "POST", path: "/api/v1/meetings/sync" });
    expect(sync.withoutGoogleAccount.length).toBeGreaterThan(0);
  });
});

describe("isDemoEnabled", () => {
  it("is true only for explicit opt-in flags", () => {
    expect(isDemoEnabled({ VITE_DEMO: "1" })).toBe(true);
    expect(isDemoEnabled({ VITE_DEMO: "true" })).toBe(true);
    expect(isDemoEnabled({ VITE_DEMO: "false" })).toBe(false);
    expect(isDemoEnabled({})).toBe(false);
    expect(isDemoEnabled(undefined)).toBe(false);
  });
});

// The admin RBAC console (FE7) drives these endpoints through the demo transport.
// Each `api()` gets a fresh in-session roster store, so mutations here are isolated.
describe("admin RBAC console (interactive roster surface)", () => {
  interface Role { id: string; name: string; permissions: string[]; isSystem: boolean }
  interface Page<T> { items: T[] }
  const roles = (a: ReturnType<typeof api>) => a.request<Page<Role>>({ method: "GET", path: "/api/v1/identity/roles" });

  it("serves the 3 agreed tiers admin / maintainer / member and the 74-key catalog", async () => {
    const a = api();
    const list = await roles(a);
    expect(list.items.filter((r) => r.isSystem).map((r) => r.name)).toEqual(["admin", "maintainer", "member"]);
    // Plus one custom 統括 role demoing cross-role mail visibility.
    const lead = list.items.find((r) => !r.isSystem) as { name: string; mailVisibleRoleIds?: string[] } | undefined;
    expect(lead?.name).toBe("統括");
    expect(lead?.mailVisibleRoleIds).toEqual(["role_maintainer", "role_member"]);
    const catalog = await a.request<unknown[]>({ method: "GET", path: "/api/v1/identity/permissions/catalog" });
    expect(catalog).toHaveLength(74);
  });

  it("① permission-matrix edit: PATCH a system role is rejected, a custom role persists", async () => {
    const a = api();
    // system role is read-only
    let denied: unknown;
    try {
      await a.request({ method: "PATCH", path: "/api/v1/identity/roles/role_member", body: { permissions: ["identity:admin"] } });
    } catch (e) {
      denied = e;
    }
    expect(ApiError.isApiError(denied)).toBe(true);
    expect((denied as ApiError).status).toBe(409);

    // create then edit a custom role — the new permission set is read back
    const created = await a.request<Role>({ method: "POST", path: "/api/v1/identity/roles", body: { name: "広報", permissions: ["event:read"] } });
    const updated = await a.request<Role>({ method: "PATCH", path: `/api/v1/identity/roles/${created.id}`, body: { permissions: ["event:read", "mail:read", "mail:send"] } });
    expect(updated.permissions).toEqual(["event:read", "mail:read", "mail:send"]);
  });

  it("② role add: POST creates a custom role that appears in the list; duplicate name 409s", async () => {
    const a = api();
    const before = (await roles(a)).items.length;
    const created = await a.request<Role>({ method: "POST", path: "/api/v1/identity/roles", body: { name: "会場", permissions: ["file:read"] } });
    expect(created.isSystem).toBe(false);
    expect((await roles(a)).items.length).toBe(before + 1);

    let dup: unknown;
    try {
      await a.request({ method: "POST", path: "/api/v1/identity/roles", body: { name: "会場", permissions: [] } });
    } catch (e) {
      dup = e;
    }
    expect((dup as ApiError).status).toBe(409);
  });

  it("③ user assignment: POST assigns a role, reflected in the user's roles + effective permissions", async () => {
    const a = api();
    // usr_dave starts unassigned (invited)
    const beforeRoles = await a.request<unknown[]>({ method: "GET", path: "/api/v1/identity/users/usr_dave/roles" });
    expect(beforeRoles).toHaveLength(0);

    const asg = await a.request<{ id: string; roleName: string }>({ method: "POST", path: "/api/v1/identity/users/usr_dave/roles", body: { roleId: "role_member" } });
    expect(asg.roleName).toBe("member");

    const afterRoles = await a.request<unknown[]>({ method: "GET", path: "/api/v1/identity/users/usr_dave/roles" });
    expect(afterRoles).toHaveLength(1);
    const detail = await a.request<{ roleIds: string[]; permissions: string[] }>({ method: "GET", path: "/api/v1/identity/users/usr_dave" });
    expect(detail.roleIds).toContain("role_member");
    expect(detail.permissions).toContain("event:read");

    // revoke it back out
    await a.request({ method: "DELETE", path: `/api/v1/identity/users/usr_dave/roles/${asg.id}` });
    expect(await a.request<unknown[]>({ method: "GET", path: "/api/v1/identity/users/usr_dave/roles" })).toHaveLength(0);
  });

  it("change history (audit) surfaces identity.* actions and grows after a mutation", async () => {
    const a = api();
    const seeded = await a.request<Page<{ action: string }>>({ method: "GET", path: "/api/v1/audit/logs", query: { action: "identity." } });
    expect(seeded.items.length).toBeGreaterThan(0);
    expect(seeded.items.every((r) => r.action.startsWith("identity."))).toBe(true);

    await a.request({ method: "POST", path: "/api/v1/identity/roles", body: { name: "監査テスト", permissions: [] } });
    const after = await a.request<Page<{ action: string }>>({ method: "GET", path: "/api/v1/audit/logs", query: { action: "identity." } });
    expect(after.items.length).toBe(seeded.items.length + 1);
    expect(after.items[0]!.action).toBe("identity.role.created");
  });
});

// メールアドレス管理 (Cloudflare Email Routing @developershub.jp) tab.
describe("admin email routing (@developershub.jp address management)", () => {
  interface Addr { id: string; localPart: string; address: string; destination: string; enabled: boolean }
  interface Page<T> { items: T[] }
  // Frontend calls the ISSUED (zone-rule) surface since #468 — the demo mock must serve
  // it, not the removed account-scoped /addresses path (regression: the 発行済みアドレス
  // dialog listed via /issued-addresses and 404'd against the stale mock).
  const BASE = "/api/v1/mail/admin/email-routing/issued-addresses";
  const list = (a: ReturnType<typeof api>) => a.request<Page<Addr>>({ method: "GET", path: BASE });

  it("the demo admin holds mail:admin (so the tab is reachable) and lists @developershub.jp addresses", async () => {
    const a = api();
    const me = await a.auth.me();
    expect(me.permissions).toContain("mail:admin");
    const addrs = await list(a);
    expect(addrs.items.length).toBeGreaterThan(0);
    expect(addrs.items.every((x) => x.address.endsWith("@developershub.jp"))).toBe(true);
  });

  it("issue: POST creates an address with only a local part (destination fixed to the mail Worker); bad local part 400", async () => {
    const a = api();
    const before = (await list(a)).items.length;
    // No destination supplied — the forward target is fixed to the mail Worker server-side.
    const created = await a.request<Addr>({ method: "POST", path: BASE, body: { localPart: "events" } });
    expect(created.address).toBe("events@developershub.jp");
    expect(created.enabled).toBe(true);
    expect(created.destination).toBe("mail-gateway (Worker)");
    expect((await list(a)).items.length).toBe(before + 1);

    let e: unknown;
    try {
      await a.request({ method: "POST", path: BASE, body: { localPart: "Bad Space" } });
    } catch (err) {
      e = err;
    }
    expect((e as ApiError).status).toBe(400);
  });

  it("enable/disable via PATCH and delete via DELETE persist", async () => {
    const a = api();
    const target = (await list(a)).items.find((x) => x.enabled)!;
    const toggled = await a.request<Addr>({ method: "PATCH", path: `${BASE}/${target.id}`, body: { enabled: false } });
    expect(toggled.enabled).toBe(false);

    await a.request({ method: "DELETE", path: `${BASE}/${target.id}` });
    expect((await list(a)).items.some((x) => x.id === target.id)).toBe(false);
  });

  it("roster-addresses (sync source) lists the receiving addresses for Email Routing 同期", async () => {
    const a = api();
    const res = await a.request<{ items: Array<{ address: string; destination: string; enabled: boolean }> }>({
      method: "GET",
      path: "/api/v1/mail/admin/email-routing/roster-addresses",
    });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((x) => x.address.endsWith("@developershub.jp"))).toBe(true);
  });
});

describe("統括 demo account (cross-role mail visibility)", () => {
  const inbox = async (account: string) => {
    globalThis.localStorage.setItem("dub_demo_account", account);
    try {
      const res = await api().request<{ items: { id: string; mine?: boolean }[] }>({ method: "GET", path: "/api/v1/mail/messages" });
      return res.items.map((m) => [m.id, m.mine]);
    } finally {
      globalThis.localStorage.removeItem("dub_demo_account");
    }
  };

  it("reads the maintainer + member inboxes as 自分宛て以外, one-way", async () => {
    const lead = await inbox("usr_lead");
    expect(lead).toContainEqual(["msg_l1", true]);
    expect(lead).toContainEqual(["msg_b1", false]);
    expect(lead).toContainEqual(["msg_s1", false]);
    expect((await inbox("usr_bob")).map(([id]) => id)).not.toContain("msg_l1");
  });
});

describe("demo outbox reply threading", () => {
  it("stamps a reply's sent row with the replied conversation's threadId (like GET /sent on the gateway)", async () => {
    globalThis.localStorage.removeItem("dub_demo_sent_usr_demo");
    const client = api();
    const send = (body: Record<string, unknown>) => client.request({ method: "POST", path: "/api/v1/mail/outbox", body });
    await send({ to: [{ email: "hanako@example.com" }], subject: "Re: 登壇のご相談", textBody: "ありがとうございます", inReplyTo: "<m1@demo>" });
    await send({ to: [{ email: "x@example.com" }], subject: "新規", textBody: "hi" });
    const sent = await client.request<{ items: { subject: string; threadId?: string }[] }>({ method: "GET", path: "/api/v1/mail/sent" });
    expect(sent.items.find((s) => s.subject === "Re: 登壇のご相談")?.threadId).toBe("thr_1");
    expect(sent.items.find((s) => s.subject === "新規")?.threadId).toBeUndefined();
  });
});

describe("demo mail Cc", () => {
  it("serves a received mail with Cc on list, detail and thread", async () => {
    const client = api();
    const cc = [{ email: "yuki@example.com", name: "伊藤 由紀" }, { email: "office@example.net" }];
    const list = await client.request<{ items: { id: string; cc?: unknown }[] }>({ method: "GET", path: "/api/v1/mail/messages" });
    expect(list.items.find((m) => m.id === "msg_4")?.cc).toEqual(cc);
    const thread = await client.request<{ messages: { cc?: unknown }[] }>({ method: "GET", path: "/api/v1/mail/threads/thr_4" });
    expect(thread.messages[0]!.cc).toEqual(cc);
  });

  it("stores the archive auto-CC but hides it from Sent list/detail (like the gateway)", async () => {
    globalThis.localStorage.removeItem("dub_demo_sent_usr_demo");
    const client = api();
    await client.request({ method: "POST", path: "/api/v1/mail/outbox", body: { to: [{ email: "x@example.com" }], cc: [{ email: "boss@example.com" }], subject: "cc", textBody: "b" } });
    await client.request({ method: "POST", path: "/api/v1/mail/outbox", body: { to: [{ email: "x@example.com" }], subject: "nocc", textBody: "b" } });
    expect(globalThis.localStorage.getItem("dub_demo_sent_usr_demo")).toContain("archive@developershub.jp");
    const sent = await client.request<{ items: { id: string; subject: string; cc?: unknown }[] }>({ method: "GET", path: "/api/v1/mail/sent" });
    const withCc = sent.items.find((s) => s.subject === "cc")!;
    expect(withCc.cc).toEqual([{ email: "boss@example.com" }]);
    expect(sent.items.find((s) => s.subject === "nocc")!.cc).toBeUndefined();
    const detail = await client.request<{ cc?: unknown }>({ method: "GET", path: `/api/v1/mail/sent/${withCc.id}` });
    expect(detail.cc).toEqual([{ email: "boss@example.com" }]);
  });
});

describe("demo inbox showcases the reply nudge", () => {
  it("has one read human mail in the 3..14 day window and one recent one", async () => {
    const res = await api().request<{ items: { id: string; receivedAt: string; read: boolean }[] }>({ method: "GET", path: "/api/v1/mail/messages" });
    const age = (id: string) => Math.floor((Date.now() - Date.parse(res.items.find((m) => m.id === id)!.receivedAt)) / 86_400_000);
    expect(age("msg_3")).toBe(4);
    expect(res.items.find((m) => m.id === "msg_3")!.read).toBe(true);
    expect(age("msg_2")).toBeLessThan(3);
  });
});

describe("demo flags mock persists 返信不要 (noReplyAt)", () => {
  it("noReply:true stamps, unrelated patches keep it, noReply:false clears; GET reads it back", async () => {
    globalThis.localStorage.removeItem("dub-demo-mail-flags:usr_demo");
    const client = api();
    const post = (body: Record<string, unknown>) =>
      client.request<{ noReplyAt: string | null; starred: boolean }>({ method: "POST", path: "/api/v1/mail/flags/thr_3", body });
    const set = await post({ noReply: true });
    expect(set.noReplyAt).toMatch(/^\d{4}-/);
    expect((await post({ starred: true })).noReplyAt).toBe(set.noReplyAt);
    const list = await client.request<{ items: { threadId: string; noReplyAt: string | null }[] }>({ method: "GET", path: "/api/v1/mail/flags" });
    expect(list.items.find((f) => f.threadId === "thr_3")?.noReplyAt).toBe(set.noReplyAt);
    expect(await post({ noReply: false })).toMatchObject({ noReplyAt: null, starred: true });
  });
});

describe("chat channel delete + org-wide sections (demo store)", () => {
  interface Section { id: string; name: string; position: number }
  interface SectionList { items: Section[]; assignments: Record<string, string> }
  const listSections = (a: ReturnType<typeof api>) => a.request<SectionList>({ method: "GET", path: "/api/v1/chat/sections" });
  const channelIds = async (a: ReturnType<typeof api>) =>
    (await a.request<{ id: string }[]>({ method: "GET", path: "/api/v1/chat/channels" })).map((c) => c.id);

  it("grants the demo admin chat:delete_channel", async () => {
    expect((await api().auth.me()).permissions).toContain("chat:delete_channel");
  });

  it("starts chat:delete_channel OFF for every non-admin role in ロール管理", async () => {
    const roles = await api().request<{ items: { name: string; permissions: string[] }[] }>({ method: "GET", path: "/api/v1/identity/roles" });
    for (const r of roles.items.filter((x) => x.name !== "admin")) {
      expect(r.permissions, r.name).not.toContain("chat:delete_channel");
    }
  });

  it("grants the demo admin chat:slack_import", async () => {
    expect((await api().auth.me()).permissions).toContain("chat:slack_import");
  });

  it("starts chat:slack_import OFF for every non-admin role in ロール管理", async () => {
    const roles = await api().request<{ items: { name: string; permissions: string[] }[] }>({ method: "GET", path: "/api/v1/identity/roles" });
    for (const r of roles.items.filter((x) => x.name !== "admin")) {
      expect(r.permissions, r.name).not.toContain("chat:slack_import");
    }
  });

  it("grants the demo admin chat:emoji_import and starts it OFF for every other role", async () => {
    expect((await api().auth.me()).permissions).toContain("chat:emoji_import");
    const roles = await api().request<{ items: { name: string; permissions: string[] }[] }>({ method: "GET", path: "/api/v1/identity/roles" });
    for (const r of roles.items.filter((x) => x.name !== "admin")) {
      expect(r.permissions, r.name).not.toContain("chat:emoji_import");
    }
  });

  it("grants the demo admin chat:manage_sections and starts it OFF for every other role", async () => {
    expect((await api().auth.me()).permissions).toContain("chat:manage_sections");
    const roles = await api().request<{ items: { name: string; permissions: string[] }[] }>({ method: "GET", path: "/api/v1/identity/roles" });
    for (const r of roles.items.filter((x) => x.name !== "admin")) {
      expect(r.permissions, r.name).not.toContain("chat:manage_sections");
    }
  });

  it("sections are shared by every account; only chat:manage_sections may organize them", async () => {
    const a = api();
    const created = await a.request<Section>({ method: "POST", path: "/api/v1/chat/sections", body: { name: "共通" } });
    await a.request<void>({ method: "PUT", path: "/api/v1/chat/channels/chn_general/section", body: { sectionId: created.id } });
    globalThis.localStorage.setItem("dub_demo_account", "usr_bob");
    try {
      expect((await a.auth.me()).permissions).not.toContain("chat:manage_sections");
      const seen = await listSections(a);
      expect(seen.items.map((x) => x.name)).toEqual(["運営", "共通"]);
      expect(seen.assignments.chn_general).toBe(created.id);
      for (const req of [
        { method: "POST", path: "/api/v1/chat/sections", body: { name: "x" } },
        { method: "PATCH", path: `/api/v1/chat/sections/${created.id}`, body: { name: "y" } },
        { method: "DELETE", path: `/api/v1/chat/sections/${created.id}` },
        { method: "PUT", path: "/api/v1/chat/channels/chn_general/section", body: { sectionId: null } },
      ] as const) {
        let err: unknown;
        try {
          await a.request<unknown>(req);
        } catch (e) {
          err = e;
        }
        expect((err as ApiError | undefined)?.status, `${req.method} ${req.path}`).toBe(403);
      }
    } finally {
      globalThis.localStorage.removeItem("dub_demo_account");
    }
  });

  it("hard-deletes a topic channel (and its assignment) but refuses a DM", async () => {
    const a = api();
    expect((await listSections(a)).assignments.chn_admin).toBe("sec_demo_ops");
    await a.request<void>({ method: "DELETE", path: "/api/v1/chat/channels/chn_admin" });
    expect(await channelIds(a)).not.toContain("chn_admin");
    expect((await listSections(a)).assignments.chn_admin).toBeUndefined();
    let err: unknown;
    try {
      await a.request<void>({ method: "DELETE", path: "/api/v1/chat/channels/chn_dm_bob" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
  });

  it("seeds 運営 and supports create / rename / assign / delete", async () => {
    const a = api();
    expect((await listSections(a)).items.map((x) => x.name)).toEqual(["運営"]);
    const created = await a.request<Section>({ method: "POST", path: "/api/v1/chat/sections", body: { name: " 広報 " } });
    expect(created.name).toBe("広報");
    const renamed = await a.request<Section>({ method: "PATCH", path: `/api/v1/chat/sections/${created.id}`, body: { name: "PR" } });
    expect(renamed.name).toBe("PR");
    await a.request<void>({ method: "PUT", path: "/api/v1/chat/channels/chn_general/section", body: { sectionId: created.id } });
    expect((await listSections(a)).assignments.chn_general).toBe(created.id);
    await a.request<void>({ method: "DELETE", path: `/api/v1/chat/sections/${created.id}` });
    const after = await listSections(a);
    expect(after.items.map((x) => x.id)).toEqual(["sec_demo_ops"]);
    expect(after.assignments.chn_general).toBeUndefined();
  });

  it("backs the channel details modal: rename / topic / archive (versioned) and members", async () => {
    const a = api();
    expect((await a.auth.me()).permissions).toContain("chat:moderate");
    interface Wire { name: string; topic: string | null; archived: boolean; version: number; memberCount: number }
    const updated = await a.request<Wire>({ method: "PATCH", path: "/api/v1/chat/channels/chn_dev", body: { name: "dev-core", topic: "", version: 1 } });
    expect(updated).toMatchObject({ name: "dev-core", topic: null, version: 2 });
    const archived = await a.request<Wire>({ method: "PATCH", path: "/api/v1/chat/channels/chn_dev", body: { archived: true, version: 2 } });
    expect(archived.archived).toBe(true);
    let err: unknown;
    try {
      await a.request<Wire>({ method: "PATCH", path: "/api/v1/chat/channels/chn_dev", body: { archived: false, version: 1 } });
    } catch (e) {
      err = e;
    }
    expect((err as ApiError).status).toBe(409);

    const members = () => a.request<{ userId: string; role: string }[]>({ method: "GET", path: "/api/v1/chat/channels/chn_team_ops/members" });
    expect((await members()).map((m) => m.userId)).toEqual(["usr_demo", "usr_bob"]);
    await a.request({ method: "POST", path: "/api/v1/chat/channels/chn_team_ops/members", body: { userId: "usr_carol" } });
    await a.request<void>({ method: "DELETE", path: "/api/v1/chat/channels/chn_team_ops/members/usr_bob" });
    expect((await members()).map((m) => m.userId)).toEqual(["usr_demo", "usr_carol"]);
  });
});

describe("カスタム絵文字 (Slack emoji import demo)", () => {
  interface Emoji { name: string; aliasOf: string | null }
  interface Result { total: number; imported: number; nextAfter: string | null }
  interface Msg { id: string; reactions: { emoji: string; userIds: string[] }[] }

  it("starts with two emoji, imports the rest in batches, and serves image bytes", async () => {
    const a = api();
    const before = await a.request<{ items: Emoji[] }>({ method: "GET", path: "/api/v1/chat/custom-emojis" });
    expect(before.items.map((e) => e.name)).toEqual(["devhub", "kit-dev"]);
    const img = await a.download("/api/v1/chat/custom-emojis/kit-dev/image");
    expect(img.type).toBe("image/svg+xml");
    await expect(a.download("/api/v1/chat/custom-emojis/partyparrot/image")).rejects.toBeInstanceOf(ApiError);

    let after: string | null = null;
    let r: Result;
    let calls = 0;
    do {
      r = await a.request<Result>({ method: "POST", path: "/api/v1/chat/custom-emojis/slack-import", body: { after } });
      after = r.nextAfter;
      calls += 1;
    } while (after && calls < 20);
    expect(calls).toBeGreaterThan(1);
    expect(r.imported).toBe(r.total);
    const list = await a.request<{ items: Emoji[] }>({ method: "GET", path: "/api/v1/chat/custom-emojis" });
    expect(list.items.find((e) => e.name === "parrot")?.aliasOf).toBe("partyparrot");
    expect((await a.download("/api/v1/chat/custom-emojis/parrot/image")).size).toBeGreaterThan(0);
  });

  it("seeds custom emoji reactions in #general and toggles a :name: reaction", async () => {
    const a = api();
    const page = await a.request<{ items: Msg[] }>({ method: "GET", path: "/api/v1/chat/messages", query: { channelId: "chn_general" } });
    const welcome = page.items.find((m) => m.id === "msg_01SEEDGEN0000000000000WEL")!;
    expect(welcome.reactions.map((r) => r.emoji)).toEqual(["🎉", ":kit-dev:", ":partyparrot:"]);
    const added = await a.request<Msg & { messageId: string }>({ method: "POST", path: `/api/v1/chat/messages/${welcome.id}/reactions`, body: { emoji: ":devhub:" } });
    expect(added.reactions.find((r) => r.emoji === ":devhub:")?.userIds).toHaveLength(1);
    const removed = await a.request<Msg>({ method: "POST", path: `/api/v1/chat/messages/${welcome.id}/reactions`, body: { emoji: ":devhub:" } });
    expect(removed.reactions.find((r) => r.emoji === ":devhub:")).toBeUndefined();
  });
});

describe("チャンネル取り込み (Slack import demo)", () => {
  interface Job { id: string; status: string; dubChannelId: string; retryAfterMs: number }
  interface Msg { id: string; authorId: string | null; threadRootId: string | null; replyCount: number; reactions: unknown[]; attachments: unknown[] }

  it("imports a channel to done and materializes thread, reactions, placeholders, pins, files", async () => {
    const a = api();
    const channels = await a.request<{ items: { name: string; isPrivate: boolean; job: { status: string } | null }[] }>({ method: "GET", path: "/api/v1/chat/slack-import/channels" });
    expect(channels.items.find((c) => c.name === "conference-core")?.isPrivate).toBe(true);
    expect(channels.items.find((c) => c.name === "design-review")?.job?.status).toBe("done");

    let job = await a.request<Job>({ method: "POST", path: "/api/v1/chat/slack-import/jobs", body: { channel: "#general" } });
    for (let i = 0; i < 30 && job.status !== "done"; i++) {
      if (job.retryAfterMs > 0) await new Promise((r) => setTimeout(r, job.retryAfterMs));
      job = await a.request<Job>({ method: "POST", path: `/api/v1/chat/slack-import/jobs/${job.id}/step` });
    }
    expect(job.status).toBe("done");

    const list = await a.request<{ id: string; visibility: string }[]>({ method: "GET", path: "/api/v1/chat/channels" });
    expect(list.map((c) => c.id)).toContain(job.dubChannelId);
    const top = await a.request<{ items: Msg[] }>({ method: "GET", path: "/api/v1/chat/messages", query: { channelId: job.dubChannelId } });
    expect(top.items.every((m) => m.threadRootId === null)).toBe(true);
    const root = top.items.find((m) => m.replyCount > 0)!;
    expect(root.reactions.length).toBeGreaterThan(0);
    const replies = await a.request<{ items: Msg[] }>({ method: "GET", path: "/api/v1/chat/messages", query: { channelId: job.dubChannelId, threadRootId: root.id } });
    expect(replies.items).toHaveLength(3);
    expect(top.items.some((m) => m.attachments.length > 0)).toBe(true);
    const pins = await a.request<Msg[]>({ method: "GET", path: `/api/v1/chat/channels/${job.dubChannelId}/pins` });
    expect(pins.some((m) => m.authorId === null)).toBe(true); // bookmark post
    const users = await a.request<{ items: { id: string; displayName: string }[] }>({ method: "GET", path: "/api/v1/identity/users", query: { ids: "usr_slk_bot_github" } });
    expect(users.items.find((u) => u.id === "usr_slk_bot_github")?.displayName).toBe("GitHub (bot)");
  }, 15_000);

  it("404s an unknown Slack channel", async () => {
    await expect(api().request({ method: "POST", path: "/api/v1/chat/slack-import/jobs", body: { channel: "nope" } })).rejects.toMatchObject({ status: 404 });
  });
});

describe("demo mail list paging (?demo_mail_bulk)", () => {
  it("pages the inbox by limit + id cursor when bulk mail is seeded", async () => {
    globalThis.history.replaceState(null, "", "/?demo_mail_bulk=60");
    try {
      const a = api();
      type Page = { items: { id: string }[]; nextCursor: string | null };
      const p1 = await a.request<Page>({ method: "GET", path: "/api/v1/mail/messages", query: { limit: 50 } });
      expect(p1.items).toHaveLength(50);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = await a.request<Page>({ method: "GET", path: "/api/v1/mail/messages", query: { limit: 50, cursor: p1.nextCursor! } });
      expect(p2.items.length).toBeGreaterThan(0);
      expect(p2.items.some((m) => p1.items.some((x) => x.id === m.id))).toBe(false);
      expect(p2.nextCursor).toBeNull();
    } finally {
      globalThis.history.replaceState(null, "", "/");
    }
  });
});
