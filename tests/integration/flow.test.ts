// Cross-service happy-path E2E (integration-e2e §7 横断E2E). Drives the REAL
// api-gateway -> auth-service -> identity-roster -> event-service path with in-
// memory repos; task/notification/audit are faithful in-memory stubs. Playwright
// (real browser) is the preview-target layer of the same catalog; here the SPA
// edge is exercised at the gateway HTTP boundary (jsdom-free).
import { describe, it, expect } from "vitest";
import { createHarness } from "../lib/harness";
import type { event, task, notification, auditLog, gateway } from "@dub/types";

describe("S1 login -> gateway -> home reflects identity/events/notifications", () => {
  it("test-login issues a bearer the gateway accepts, and /bff/home aggregates", async () => {
    const h = await createHarness();
    const token = await h.login("organizer");
    expect(token).toBeTruthy();

    const home = await h.gw("GET", "/api/v1/bff/home", { token });
    expect(home.status).toBe(200);
    const body = home.json<gateway.BffHomeResponse>();
    expect(body).toHaveProperty("upcomingEvents");
    expect(body).toHaveProperty("unreadCount");
    expect(body.partialErrors).toEqual([]);
  });

  it("identity master is reachable through the gateway proxy (/api/v1/identity/users/:id)", async () => {
    const h = await createHarness();
    const token = await h.login("organizer");
    const res = await h.gw("GET", `/api/v1/identity/users/${h.users.organizer.userId}`, { token });
    expect(res.status).toBe(200);
    const user = res.json<{ id: string; orgId: string; permissions: string[] }>();
    expect(user.id).toBe(h.users.organizer.userId);
    expect(user.orgId).toBe(h.users.organizer.orgId);
    expect(user.permissions).toContain("event:write");
  });
});

describe("S2 event -> action hierarchy (create, then read back)", () => {
  it("organizer creates an event and an action; both persist and read back", async () => {
    const h = await createHarness();
    const org = await h.login("organizer");

    const created = await h.gw("POST", "/api/v1/events", {
      token: org,
      body: { title: "Hokuriku IT Conference", startsAt: "2026-12-01T09:00:00Z" },
    });
    expect(created.status).toBe(201);
    const ev = created.json<event.DubEvent>();
    expect(ev.phase).toBe("planning");
    expect(ev.version).toBe(1);

    const action = await h.gw("POST", `/api/v1/events/${ev.id}/actions`, {
      token: org,
      body: { kind: "session", title: "Opening Keynote" },
    });
    expect(action.status).toBe(201);

    // read back through GET /events/:id/actions
    const list = await h.gw("GET", `/api/v1/events/${ev.id}/actions`, { token: org });
    expect(list.status).toBe(200);
    const actions = list.json<{ items: { title: string }[] }>();
    expect(actions.items.map((a) => a.title)).toContain("Opening Keynote");

    // upcoming events now appear on the home BFF
    const home = await h.gw("GET", "/api/v1/bff/home", { token: org });
    expect(home.json<gateway.BffHomeResponse>().upcomingEvents.map((e) => e.id)).toContain(ev.id);
  });
});

describe("S3 task create -> organizer assigns member -> state visible", () => {
  it("assigns a task to a member and lists it filtered by assignee", async () => {
    const h = await createHarness();
    const org = await h.login("organizer");

    const ev = (await h.gw("POST", "/api/v1/events", { token: org, body: { title: "Ev" } })).json<event.DubEvent>();
    const tk = await h.gw("POST", "/api/v1/tasks", { token: org, body: { eventId: ev.id, title: "Prepare slides" } });
    expect(tk.status).toBe(201);
    const t = tk.json<task.Task>();
    expect(t.assigneeId).toBeNull();

    const assigned = await h.gw("PATCH", `/api/v1/tasks/${t.id}`, {
      token: org,
      body: { version: t.version, assigneeId: h.users.member.userId },
    });
    expect(assigned.status).toBe(200);
    expect(assigned.json<task.Task>().assigneeId).toBe(h.users.member.userId);

    const filtered = await h.gw("GET", `/api/v1/tasks?assigneeId=${h.users.member.userId}`, { token: org });
    expect(filtered.status).toBe(200);
    expect(filtered.json<task.ListTasksResponse>().items.map((x) => x.id)).toContain(t.id);
  });

  it("optimistic concurrency: stale version PATCH is 409", async () => {
    const h = await createHarness();
    const org = await h.login("organizer");
    const ev = (await h.gw("POST", "/api/v1/events", { token: org, body: { title: "Ev" } })).json<event.DubEvent>();
    const t = (await h.gw("POST", "/api/v1/tasks", { token: org, body: { eventId: ev.id, title: "T" } })).json<task.Task>();
    const stale = await h.gw("PATCH", `/api/v1/tasks/${t.id}`, { token: org, body: { version: 999, status: "in_progress" } });
    expect(stale.status).toBe(409);
  });
});

describe("S5 notification: assignment -> member inbox (Queue fan-out simulated in-process)", () => {
  it("assigning a task lands a task.assigned item in the assignee inbox; read marks it", async () => {
    const h = await createHarness();
    const org = await h.login("organizer");
    const member = await h.login("member");

    const ev = (await h.gw("POST", "/api/v1/events", { token: org, body: { title: "Ev" } })).json<event.DubEvent>();
    const t = (await h.gw("POST", "/api/v1/tasks", { token: org, body: { eventId: ev.id, title: "Deploy" } })).json<task.Task>();
    await h.gw("PATCH", `/api/v1/tasks/${t.id}`, { token: org, body: { version: t.version, assigneeId: h.users.member.userId } });

    const inbox = await h.gw("GET", "/api/v1/notifications/inbox", { token: member });
    expect(inbox.status).toBe(200);
    const items = inbox.json<notification.ListInboxResponse>().items;
    expect(items.length).toBe(1);
    expect(items[0]!.type).toBe("task.assigned");
    expect(items[0]!.resourceId).toBe(t.id);

    const unread = await h.gw("GET", "/api/v1/notifications/inbox/unread-count", { token: member });
    expect(unread.json<notification.UnreadCountResponse>().count).toBe(1);

    const read = await h.gw("PATCH", `/api/v1/notifications/inbox/${items[0]!.id}/read`, { token: member });
    expect(read.status).toBe(200);

    const after = await h.gw("GET", "/api/v1/notifications/inbox/unread-count", { token: member });
    expect(after.json<notification.UnreadCountResponse>().count).toBe(0);
  });
});

describe("S7 audit: privileged mutations are recorded and admin-readable", () => {
  it("event creation is audited; admin reads it via /api/v1/audit/logs", async () => {
    const h = await createHarness();
    const org = await h.login("organizer");
    const admin = await h.login("admin");

    const ev = (await h.gw("POST", "/api/v1/events", { token: org, body: { title: "Audited Ev" } })).json<event.DubEvent>();

    const logs = await h.gw("GET", `/api/v1/audit/logs?resourceId=${ev.id}`, { token: admin });
    expect(logs.status).toBe(200);
    const page = logs.json<auditLog.AuditLogPage>();
    const rec = page.items.find((r) => r.action === "event.event.created");
    expect(rec).toBeDefined();
    expect(rec!.actorId).toBe(h.users.organizer.userId);
    expect(rec!.resourceId).toBe(ev.id);
  });

  it("identity role assignment is recorded via the SYNC audit path", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");

    // fetch the member role id, then grant it to the member again on a resource scope
    const roles = (await h.gw("GET", "/api/v1/identity/roles", { token: admin })).json<{ items: { id: string; name: string }[] }>();
    const memberRole = roles.items.find((r) => r.name === "member")!;

    const ev = (await h.gw("POST", "/api/v1/events", { token: admin, body: { title: "Scope" } })).json<event.DubEvent>();
    const assign = await h.gw("POST", `/api/v1/identity/users/${h.users.organizer.userId}/roles`, {
      token: admin,
      body: { roleId: memberRole.id, resourceType: "event", resourceId: ev.id },
    });
    expect(assign.status).toBe(201);

    const logs = (await h.gw("GET", "/api/v1/audit/logs?action=identity.role.assigned", { token: admin })).json<auditLog.AuditLogPage>();
    expect(logs.items.some((r) => r.action === "identity.role.assigned")).toBe(true);
  });
});
