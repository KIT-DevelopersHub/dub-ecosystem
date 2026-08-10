// Integration smoke over a seeded local D1 (node:sqlite): the primary DevHub use
// case — user -> event create -> task -> assignment -> notification inbox -> mail
// outbox — driven through the REAL service apps / repos via Hono app.request and the
// services' own SQL. The only fakes are transport seams (authz, service bindings,
// Queues, mail provider); all domain logic and every table write is the real thing.
//
// Not miniflare: node:sqlite is the same in-memory D1 the per-service suites use, so
// this stays a plain `vitest run` with no Cloudflare runtime.
import { describe, it, expect, beforeEach } from "vitest";
import type { event, task } from "@dub/types";

import { createWorld, call, ORG, USERS, type World } from "../src/world";
import {
  insertNotification,
  insertInbox,
  listInbox,
  unreadCount,
} from "../../../services/notification/src/repo";
import type { IngestInput } from "../../../services/notification/src/types";
import { sendMail } from "../../../services/mail-gateway/src/send";
import { findSendByKey } from "../../../services/mail-gateway/src/repo";

let w: World;
beforeEach(() => {
  w = createWorld();
});

describe("primary use case: user -> event -> task -> notification -> mail outbox", () => {
  it("runs the full chain across four real services over one seeded D1", async () => {
    // 1) event-service (REAL app + REAL SQL): organizer creates an event.
    const created = await call(w.eventApp, "POST", "/events", {
      userId: USERS.organizer,
      body: { title: "Hokuriku IT Conference", startsAt: "2026-12-01T09:00:00Z" },
    });
    expect(created.status).toBe(201);
    const ev = created.json as event.DubEvent;
    expect(ev.phase).toBe("planning");
    expect(ev.version).toBe(1);

    // event row is genuinely persisted (read back through the real GET route).
    const readBack = await call(w.eventApp, "GET", `/events/${ev.id}`, { userId: USERS.organizer });
    expect(readBack.status).toBe(200);
    expect((readBack.json as event.EventDetail).id).toBe(ev.id);

    // 2) task-service (REAL app + REAL SQL): create a task under the event.
    const madeTask = await call(w.taskApp, "POST", "/tasks", {
      userId: USERS.organizer,
      body: { eventId: ev.id, title: "Prepare opening keynote" },
    });
    expect(madeTask.status).toBe(201);
    const t = madeTask.json as task.Task;
    expect(t.status).toBe("todo");
    expect(t.assigneeId).toBeNull();

    // 3) assignment: PATCH raises the REAL task.assigned event through the publisher seam.
    const assigned = await call(w.taskApp, "PATCH", `/tasks/${t.id}`, {
      userId: USERS.organizer,
      body: { version: t.version, assigneeId: USERS.member },
    });
    expect(assigned.status).toBe(200);
    expect((assigned.json as task.Task).assigneeId).toBe(USERS.member);

    // the event carries the canonical @dub/events envelope shape.
    const assignedEvt = w.emitted.find((e) => e.name === "task.assigned");
    expect(assignedEvt, "task.assigned must be emitted").toBeTruthy();
    const payload = assignedEvt!.payload as { taskId: string; eventId: string; assigneeId: string };
    expect(payload.taskId).toBe(t.id);
    expect(payload.eventId).toBe(ev.id);
    expect(payload.assigneeId).toBe(USERS.member);

    // task is now visible filtered by assignee (REAL list SQL).
    const listed = await call(w.taskApp, "GET", "/tasks", {
      userId: USERS.organizer,
      query: { eventId: ev.id, assigneeId: USERS.member },
    });
    expect((listed.json as task.ListTasksResponse).items.map((x) => x.id)).toContain(t.id);

    // 4) notification (REAL notif_ SQL): the queue consumer persists a notification +
    //    per-user inbox row for the assignee, built from the real envelope.
    const ingest: IngestInput = {
      type: "task.assigned",
      recipients: { userIds: [payload.assigneeId] },
      title: "New task assigned",
      body: t.title,
      priority: "normal",
      source: "queue",
      sourceEvent: assignedEvt!.name,
      actorId: assignedEvt!.actorId,
      requestId: assignedEvt!.requestId,
      resourceType: "task",
      resourceId: payload.taskId,
    };
    const notificationId = await insertNotification(w.notifDb, ingest);
    await insertInbox(w.notifDb, notificationId, payload.assigneeId);

    const inbox = await listInbox(w.notifDb, USERS.member, { limit: 20 });
    expect(inbox.items.length).toBe(1);
    expect(inbox.items[0]!.type).toBe("task.assigned");
    expect(inbox.items[0]!.resourceId).toBe(t.id);
    expect(await unreadCount(w.notifDb, USERS.member)).toBe(1);

    // 5) mail outbox (REAL mail-gateway send core + REAL mail_send_log SQL): the email
    //    channel hands the notification to the gateway, which claims + sends it once.
    const idempotencyKey = `${notificationId}:${USERS.member}:email`;
    const res = await sendMail(
      w.makeSendDeps(),
      { to: [{ email: "member@devhub.test" }], subject: ingest.title, textBody: t.title },
      idempotencyKey,
      "notification",
    );
    expect(res.status).toBe("sent");

    const outbox = await findSendByKey(w.mailDb, idempotencyKey);
    expect(outbox).toBeTruthy();
    expect(outbox!.status).toBe("sent");
    expect(outbox!.subject).toBe(ingest.title);
    expect(JSON.parse(outbox!.to_json)).toEqual([{ email: "member@devhub.test" }]);
  });

  it("mail send is idempotent: a replay of the same key does not double-send", async () => {
    const key = "notif_x:usr_member:email";
    const req = { to: [{ email: "member@devhub.test" }], subject: "Re: task", textBody: "body" };
    const first = await sendMail(w.makeSendDeps(), req, key, "notification");
    expect(first.status).toBe("sent");
    const replay = await sendMail(w.makeSendDeps(), req, key, "notification");
    expect(replay.status).toBe("duplicate");

    // exactly one outbox row exists for the key.
    const rows = w.raw
      .prepare("SELECT COUNT(*) AS c FROM mail_send_log WHERE idempotency_key = ?")
      .all(key) as { c: number }[];
    expect(rows[0]!.c).toBe(1);
  });
});

describe("guardrails: real domain rules still bite through the smoke seams", () => {
  it("creating a task under a missing event is rejected by the real event gate", async () => {
    const res = await call(w.taskApp, "POST", "/tasks", {
      userId: USERS.organizer,
      body: { eventId: "event_does_not_exist", title: "orphan" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("a stale-version task PATCH is a 409 (optimistic concurrency)", async () => {
    const ev = (
      await call(w.eventApp, "POST", "/events", { userId: USERS.organizer, body: { title: "E" } })
    ).json as event.DubEvent;
    const t = (
      await call(w.taskApp, "POST", "/tasks", {
        userId: USERS.organizer,
        body: { eventId: ev.id, title: "T" },
      })
    ).json as task.Task;
    const stale = await call(w.taskApp, "PATCH", `/tasks/${t.id}`, {
      userId: USERS.organizer,
      body: { version: 999, status: "in_progress" },
    });
    expect(stale.status).toBe(409);
  });

  it("unauthenticated event access is a 401 (trusted-header contract)", async () => {
    const res = await call(w.eventApp, "GET", "/events");
    expect(res.status).toBe(401);
  });

  it("all four namespaces are seeded in the one local D1", () => {
    const tables = (
      w.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["event_events", "task_tasks", "notif_inbox", "mail_send_log"]),
    );
    expect(ORG).toBe("org_devhub");
  });
});
