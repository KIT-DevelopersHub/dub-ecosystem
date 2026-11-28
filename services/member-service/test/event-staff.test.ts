// 運営メンバー per event: the event selects its staff / 班 from the ONE org-wide roster.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import type { DbClient } from "@dub/db";
import { createApp, makeDeps, call } from "./harness";
import { createD1MemberRepo } from "../src/d1-repo";
import { MEMBER_MIGRATIONS } from "../src/schema";
import { buildEventInvite, EVENT_INVITED_TYPE } from "../src/eventInvite";

const EV = "acd75449-c875-4c13-83d8-2dd8f8ce8a33";
const EV2 = "event_01M8C4ZK8020EFG6KYFT7S5B2N";

async function seed() {
  const app = createApp(makeDeps());
  const team = (await call(app, "POST", "/members/teams", { body: { name: "会場" } })).json;
  const p = (await call(app, "POST", "/members/people", { body: { name: "山田 太郎", status: "added", teamIds: [team.id] } })).json;
  return { app, team, p };
}

describe("event staff (member_event_people / member_event_teams)", () => {
  it("adds / removes people and 班 per event without touching the roster", async () => {
    const { app, team, p } = await seed();
    expect((await call(app, "GET", `/members/events/${EV}/staff`)).json).toEqual({ eventId: EV, personIds: [], teamIds: [] });

    expect((await call(app, "PUT", `/members/events/${EV}/people/${p.id}`)).json.personIds).toEqual([p.id]);
    // idempotent
    expect((await call(app, "PUT", `/members/events/${EV}/people/${p.id}`)).json.personIds).toEqual([p.id]);
    expect((await call(app, "PUT", `/members/events/${EV}/teams/${team.id}`)).json.teamIds).toEqual([team.id]);
    // another event is independent
    expect((await call(app, "GET", `/members/events/${EV2}/staff`)).json.personIds).toEqual([]);

    expect((await call(app, "DELETE", `/members/events/${EV}/people/${p.id}`)).json.personIds).toEqual([]);
    expect((await call(app, "DELETE", `/members/events/${EV}/teams/${team.id}`)).json.teamIds).toEqual([]);
    // roster untouched
    expect((await call(app, "GET", "/members/overview")).json.members.map((m: { id: string }) => m.id)).toEqual([p.id]);
  });

  it("404s an unknown person / team and 400s a malformed event id", async () => {
    const { app } = await seed();
    expect((await call(app, "PUT", `/members/events/${EV}/people/member_nope`)).status).toBe(404);
    expect((await call(app, "PUT", `/members/events/${EV}/teams/team_nope`)).status).toBe(404);
    expect((await call(app, "GET", `/members/events/a%20b/staff`)).status).toBe(400);
  });

  it("adding a person / team with eventId also selects it for that event", async () => {
    const { app } = await seed();
    const t = (await call(app, "POST", "/members/teams", { body: { name: "広報", eventId: EV2 } })).json;
    const m = (await call(app, "POST", "/members/people", { body: { name: "佐藤 花", status: "added", eventId: EV2 } })).json;
    expect((await call(app, "GET", `/members/events/${EV2}/staff`)).json).toEqual({ eventId: EV2, personIds: [m.id], teamIds: [t.id] });
    expect((await call(app, "POST", "/members/people", { body: { name: "x", status: "added", eventId: "bad id" } })).status).toBe(400);
  });

  it("参加届 resolve (create) and 採用 (join) put the person on the event chosen in the form", async () => {
    const { app } = await seed();
    const sub = await call(app, "POST", "/members/participation", {
      body: { name: "新規 太郎", schoolEmail: "s@example.ac.jp", gmail: "s@gmail.com", position: "member" },
    });
    expect(sub.status).toBe(201);
    const res = await call(app, "POST", `/members/participation/${sub.json.participation.id}/resolve`, {
      body: { action: "create", eventId: EV },
    });
    expect(res.status).toBe(200);
    const created = res.json.member.id as string;

    const a = (await call(app, "POST", "/members/hr/applicants", { body: { name: "山本 花", email: "hana@example.com" } })).json.applicant;
    const joined = await call(app, "POST", `/members/hr/applicants/${a.id}/join`, { body: { expectedVersion: a.version, eventId: EV } });
    expect(joined.status).toBe(200);

    const staff = (await call(app, "GET", `/members/events/${EV}/staff`)).json;
    expect(staff.personIds.sort()).toEqual([created, joined.json.memberId].sort());
  });
});

describe("このイベントに招待 (POST /members/events/:eventId/invitations)", () => {
  async function linkedPerson(app: ReturnType<typeof createApp>, name: string, identityUserId: string) {
    const m = (await call(app, "POST", "/members/people", { body: { name, status: "added", teamIds: [] } })).json;
    await call(app, "POST", `/members/people/${m.id}/identity-link`, { body: { identityUserId, version: m.version } });
    return m.id as string;
  }

  it("adds an account holder at once and sends 「〇〇の運営に招待されました」 linking to the event", async () => {
    const sent: unknown[] = [];
    const app = createApp(makeDeps({ notifyEventInvite: async (_ctx, t) => void sent.push(buildEventInvite(t)) }));
    const id = await linkedPerson(app, "山田 花", "usr_yamada");
    const res = await call(app, "POST", `/members/events/${EV}/invitations`, { body: { personId: id, eventTitle: "北陸ITカンファレンス 2027" } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ staff: { eventId: EV, personIds: [id], teamIds: [] }, notified: true });
    expect(sent).toEqual([
      expect.objectContaining({
        type: EVENT_INVITED_TYPE,
        recipientIds: ["usr_yamada"],
        title: "「北陸ITカンファレンス 2027」の運営に招待されました",
        resourceType: "event",
        resourceId: EV,
      }),
    ]);
    // already staff
    expect((await call(app, "POST", `/members/events/${EV}/invitations`, { body: { personId: id } })).status).toBe(409);
  });

  it("refuses people without an account (they come in through 参加届) and unknown people", async () => {
    const app = createApp(makeDeps());
    const { p } = await (async () => ({ p: (await call(app, "POST", "/members/people", { body: { name: "無 垢", status: "added", teamIds: [] } })).json }))();
    const r = await call(app, "POST", `/members/events/${EV}/invitations`, { body: { personId: p.id } });
    expect(r.status).toBe(400);
    expect((await call(app, "GET", `/members/events/${EV}/staff`)).json.personIds).toEqual([]);
    expect((await call(app, "POST", `/members/events/${EV}/invitations`, { body: { personId: "member_nope" } })).status).toBe(404);
    expect((await call(app, "POST", `/members/events/${EV}/invitations`, { body: {} })).status).toBe(400);
  });

  it("a failed notification still invites, reported as notified:false", async () => {
    const app = createApp(makeDeps({ notifyEventInvite: async () => { throw new Error("down"); } }));
    const id = await linkedPerson(app, "佐藤 一", "usr_sato");
    const res = await call(app, "POST", `/members/events/${EV}/invitations`, { body: { personId: id } });
    expect(res.json).toEqual({ staff: { eventId: EV, personIds: [id], teamIds: [] }, notified: false });
  });
});

describe("参加届を出したイベント (member_participations.event_id)", () => {
  const form = { schoolEmail: "s@example.ac.jp", gmail: "s@gmail.com", position: "member" };

  it("reflecting a 届 puts the person on the event it was submitted for (no eventId in resolve)", async () => {
    const app = createApp(makeDeps());
    const sub = await call(app, "POST", "/members/participation", { body: { ...form, name: "届 太郎", eventId: EV2 } });
    expect(sub.status).toBe(201);
    expect(sub.json.participation.eventId).toBe(EV2);
    const res = await call(app, "POST", `/members/participation/${sub.json.participation.id}/resolve`, { body: { action: "create" } });
    expect((await call(app, "GET", `/members/events/${EV2}/staff`)).json.personIds).toEqual([res.json.member.id]);
  });

  it("resolve eventId:null puts them nowhere; an already reflected person resubmitting for another event joins it", async () => {
    const app = createApp(makeDeps());
    const sub = await call(app, "POST", "/members/participation", { body: { ...form, name: "届 花子", eventId: EV2 } });
    const res = await call(app, "POST", `/members/participation/${sub.json.participation.id}/resolve`, { body: { action: "create", eventId: null } });
    expect((await call(app, "GET", `/members/events/${EV2}/staff`)).json.personIds).toEqual([]);
    await call(app, "POST", "/members/participation", { body: { ...form, name: "届 花子", eventId: EV } });
    expect((await call(app, "GET", `/members/events/${EV}/staff`)).json.personIds).toEqual([res.json.member.id]);
    expect((await call(app, "POST", "/members/participation", { body: { ...form, name: "x", eventId: "bad id" } })).status).toBe(400);
  });

  it("d1 repo stores event_id", async () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    for (const m of MEMBER_MIGRATIONS) raw.exec(m.up);
    type Bind = string | number | null;
    const db = {
      namespace: "member",
      first: async (sql: string, ...b: Bind[]) => raw.prepare(sql).get(...b) ?? null,
      all: async (sql: string, ...b: Bind[]) => raw.prepare(sql).all(...b),
      run: async (sql: string, ...b: Bind[]) => {
        const r = raw.prepare(sql).run(...b);
        return { success: true, meta: { changes: Number(r.changes), durationMs: 0 } };
      },
    } as unknown as DbClient;
    const deps = makeDeps();
    const app = createApp(deps);
    const sub = await call(app, "POST", "/members/participation", { body: { ...form, name: "永続 太郎", eventId: EV } });
    const row = (await deps.repo.getParticipation(sub.json.participation.id))!;
    const repo = createD1MemberRepo(db);
    await repo.upsertParticipation(row);
    expect((await repo.getParticipation(row.id))?.eventId).toBe(EV);
    const rows = raw.prepare("SELECT event_id FROM member_participations").all() as Array<{ event_id: string }>;
    expect(rows.map((r) => r.event_id)).toEqual([EV]);
  });
});

describe("createD1MemberRepo event staff (real SQLite + migrations)", () => {
  it("round-trips, is idempotent, and deleting a team drops it from events", async () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    for (const m of MEMBER_MIGRATIONS) raw.exec(m.up);
    type Bind = string | number | null;
    const db = {
      namespace: "member",
      first: async (sql: string, ...b: Bind[]) => raw.prepare(sql).get(...b) ?? null,
      all: async (sql: string, ...b: Bind[]) => raw.prepare(sql).all(...b),
      run: async (sql: string, ...b: Bind[]) => {
        const r = raw.prepare(sql).run(...b);
        return { success: true, meta: { changes: Number(r.changes), durationMs: 0 } };
      },
    } as unknown as DbClient;
    const repo = createD1MemberRepo(db);
    await repo.addEventPerson(EV, "p1", "u", "t");
    await repo.addEventPerson(EV, "p1", "u", "t");
    await repo.addEventTeam(EV, "t1", "u", "t");
    expect(await repo.getEventStaff(EV)).toEqual({ personIds: ["p1"], teamIds: ["t1"] });
    await repo.deleteTeam("t1");
    await repo.removeEventPerson(EV, "p1");
    expect(await repo.getEventStaff(EV)).toEqual({ personIds: [], teamIds: [] });
  });
});

describe("scripts/backfill-event-staff.sql", () => {
  it("2027 gets the whole roster + every 班; miniconference gets the 5 accounts' rows + their 班; re-runnable", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    for (const m of MEMBER_MIGRATIONS) raw.exec(m.up);
    const t = "2026-01-01T00:00:00.000Z";
    for (const id of ["ta", "tb"]) {
      raw.prepare(`INSERT INTO member_teams (id, org_id, key, name, sort_order, created_at, updated_at) VALUES (?, 'o', ?, ?, 1, ?, ?)`).run(id, id, id, t, t);
    }
    const person = (id: string, user: string | null, archived: string | null = null) =>
      raw.prepare(
        `INSERT INTO member_people (id, org_id, name, status, sort_order, version, archived_at, created_by, created_at, updated_at, identity_user_id)
         VALUES (?, 'o', ?, 'added', 1, 1, ?, 'u', ?, ?, ?)`,
      ).run(id, id, archived, t, t, user);
    person("p1", "user_01KZRTAHRTPF9MHN92CTSD5X01");
    person("p2", null);
    person("p3", "user_01M4TYVCFAR6J4N3Y54PWY132W", t); // archived: nowhere
    raw.prepare(`INSERT INTO member_team_links (person_id, team_id, created_at, updated_at) VALUES ('p1', 'tb', ?, ?)`).run(t, t);

    const sql = readFileSync(new URL("../scripts/backfill-event-staff.sql", import.meta.url), "utf8");
    raw.exec(sql);
    raw.exec(sql);
    const ids = (table: string, col: string, ev: string) =>
      (raw.prepare(`SELECT ${col} AS id FROM ${table} WHERE event_id = ? ORDER BY 1`).all(ev) as Array<{ id: string }>).map((r) => r.id);
    expect(ids("member_event_people", "person_id", EV)).toEqual(["p1", "p2"]);
    expect(ids("member_event_teams", "team_id", EV)).toEqual(["ta", "tb"]);
    expect(ids("member_event_people", "person_id", EV2)).toEqual(["p1"]);
    expect(ids("member_event_teams", "team_id", EV2)).toEqual(["tb"]);
  });
});
