// D1-backed ChatRepo — real-SQL tests (workerd via miniflare, real D1).
//
// The HTTP-master suites (test/*.test.ts) all run against InMemoryChatRepo, so the
// production persistence path (src/d1-repo.ts) had no coverage: a column typo, a
// wrong ORDER BY, a broken optimistic-lock WHERE, or an ON CONFLICT regression
// would ship green. This suite drives createD1ChatRepo against a real miniflare D1
// (schema applied from CHAT_SCHEMA_MIGRATION) and asserts the SAME semantics the
// in-memory fake provides — keeping the two implementations in lockstep.
//
// isolatedStorage is false (see vitest.workers.config.ts), so the D1 is shared
// across cases in this file; every case uses a unique id prefix to stay isolated.
import { env } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { createDbClient, applyMigrations, assertAllApplied } from "@dub/db";
import { createD1ChatRepo } from "../../src/d1-repo";
import { CHAT_SCHEMA_MIGRATION, CHAT_PINS_MIGRATION, CHAT_SETTINGS_MIGRATION, CHAT_SETTINGS_PROTECT_REACTED_MIGRATION } from "../../src/schema";
import type { ChatRepo, ChannelRow, MemberRow, MessageRow } from "../../src/types";

const AT = "2026-08-10T05:00:00.000Z";

function makeRepo(): ChatRepo {
  const db = createDbClient(env.DB, { namespace: "chat" });
  return createD1ChatRepo(db);
}

// Unique id factory per case so the shared D1 does not cross-contaminate.
let caseSeq = 0;
function ns(): { chan: (n: number) => string; msg: (n: number) => string; user: (n: number) => string; evt: string } {
  const p = `${caseSeq++}`.padStart(4, "0");
  return {
    chan: (n) => `chan_${p}_${`${n}`.padStart(4, "0")}`,
    msg: (n) => `msg_${p}_${`${n}`.padStart(4, "0")}`,
    user: (n) => `user_${p}_${`${n}`.padStart(4, "0")}`,
    evt: `evt_${p}`,
  };
}

function channel(over: Partial<ChannelRow> & Pick<ChannelRow, "id" | "createdBy">): ChannelRow {
  return {
    type: "topic",
    visibility: "public",
    name: "general",
    topic: null,
    eventId: null,
    dmKey: null,
    archivedAt: null,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}
function member(channelId: string, userId: string, role: MemberRow["role"] = "member"): MemberRow {
  return { channelId, userId, role, joinedAt: AT };
}
function message(over: Partial<MessageRow> & Pick<MessageRow, "id" | "channelId">): MessageRow {
  return {
    threadRootId: null,
    authorId: null,
    kind: "user",
    body: "hi",
    attachmentFileIds: [],
    version: 1,
    editedAt: null,
    deletedAt: null,
    createdAt: AT,
    ...over,
  };
}

beforeAll(async () => {
  // Apply the chat DDL to the empty miniflare D1 (idempotent via the ledger).
  const results = await applyMigrations(env.DB, [CHAT_SCHEMA_MIGRATION, CHAT_PINS_MIGRATION, CHAT_SETTINGS_MIGRATION, CHAT_SETTINGS_PROTECT_REACTED_MIGRATION]);
  assertAllApplied(results);
});

describe("d1-repo: channels", () => {
  it("round-trips every channel field through real SQL", async () => {
    const repo = makeRepo();
    const id = ns();
    const row = channel({
      id: id.chan(1),
      type: "event",
      visibility: "private",
      name: "launch",
      topic: "the big one",
      eventId: id.evt,
      dmKey: null,
      createdBy: id.user(1),
      version: 3,
    });
    await repo.createChannel(row);
    expect(await repo.getChannel(row.id)).toEqual(row);
    expect(await repo.getChannel("chan_missing")).toBeNull();
  });

  it("resolves by dm_key and enforces the dm_key UNIQUE constraint", async () => {
    const repo = makeRepo();
    const id = ns();
    const key = `dm_${id.evt}`;
    const a = channel({ id: id.chan(1), type: "dm", visibility: "private", dmKey: key, createdBy: id.user(1) });
    await repo.createChannel(a);
    expect((await repo.getChannelByDmKey(key))?.id).toBe(a.id);
    expect(await repo.getChannelByDmKey("dm_none")).toBeNull();
    // A second channel with the same dm_key must violate the UNIQUE index.
    const dup = channel({ id: id.chan(2), type: "dm", visibility: "private", dmKey: key, createdBy: id.user(1) });
    await expect(repo.createChannel(dup)).rejects.toThrow();
  });

  it("listChannelsForUser: public visible to non-members, private only to members", async () => {
    const repo = makeRepo();
    const id = ns();
    const viewer = id.user(9);
    const pub = channel({ id: id.chan(1), visibility: "public", createdBy: id.user(1) });
    const priv = channel({ id: id.chan(2), visibility: "private", createdBy: id.user(1) });
    const privMember = channel({ id: id.chan(3), visibility: "private", createdBy: id.user(1) });
    await repo.createChannel(pub);
    await repo.createChannel(priv);
    await repo.createChannel(privMember);
    await repo.addMember(member(privMember.id, viewer));

    const rows = await repo.listChannelsForUser({ userId: viewer, includeArchived: false, limit: 50 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(pub.id); // public: visible without membership
    expect(ids).toContain(privMember.id); // private + member: visible
    expect(ids).not.toContain(priv.id); // private + non-member: hidden
  });

  it("listChannelsForUser: excludes archived, filters by eventId, keyset paginates by id", async () => {
    const repo = makeRepo();
    const id = ns();
    const viewer = id.user(9);
    const c1 = channel({ id: id.chan(1), createdBy: viewer, eventId: id.evt, type: "event" });
    const c2 = channel({ id: id.chan(2), createdBy: viewer, eventId: id.evt, type: "event" });
    const c3 = channel({ id: id.chan(3), createdBy: viewer, eventId: id.evt, type: "event" });
    const archived = channel({ id: id.chan(4), createdBy: viewer, archivedAt: AT });
    const otherEvent = channel({ id: id.chan(5), createdBy: viewer, eventId: `${id.evt}_other`, type: "event" });
    for (const c of [c1, c2, c3, archived, otherEvent]) {
      await repo.createChannel(c);
      await repo.addMember(member(c.id, viewer));
    }

    // archived excluded
    const active = await repo.listChannelsForUser({ userId: viewer, includeArchived: false, limit: 50 });
    expect(active.map((r) => r.id)).not.toContain(archived.id);

    // eventId filter
    const forEvent = await repo.listChannelsForUser({ userId: viewer, eventId: id.evt, includeArchived: false, limit: 50 });
    expect(forEvent.map((r) => r.id).sort()).toEqual([c1.id, c2.id, c3.id]);

    // keyset: ORDER BY id ASC, LIMIT, then afterId = last seen
    const page1 = await repo.listChannelsForUser({ userId: viewer, eventId: id.evt, includeArchived: false, limit: 2 });
    expect(page1.map((r) => r.id)).toEqual([c1.id, c2.id]);
    const page2 = await repo.listChannelsForUser({ userId: viewer, eventId: id.evt, includeArchived: false, limit: 2, afterId: c2.id });
    expect(page2.map((r) => r.id)).toEqual([c3.id]);
  });

  it("updateChannel is optimistic-locked (changes>0 only on version match)", async () => {
    const repo = makeRepo();
    const id = ns();
    const row = channel({ id: id.chan(1), createdBy: id.user(1), version: 1 });
    await repo.createChannel(row);

    const next: ChannelRow = { ...row, name: "renamed", topic: "t", archivedAt: AT, version: 2, updatedAt: AT };
    expect(await repo.updateChannel(next, 999)).toBe(false); // stale version -> no write
    expect((await repo.getChannel(row.id))?.name).toBe("general"); // unchanged
    expect(await repo.updateChannel(next, 1)).toBe(true); // correct version -> write
    const after = await repo.getChannel(row.id);
    expect(after).toMatchObject({ name: "renamed", topic: "t", archivedAt: AT, version: 2 });
    expect(await repo.updateChannel(next, 1)).toBe(false); // version already advanced
  });
});

describe("d1-repo: members", () => {
  it("addMember upserts role, removeMember is idempotent, listings order deterministically", async () => {
    const repo = makeRepo();
    const id = ns();
    const chan = channel({ id: id.chan(1), createdBy: id.user(1) });
    await repo.createChannel(chan);
    const u = id.user(2);

    await repo.addMember(member(chan.id, u, "member"));
    expect((await repo.getMember(chan.id, u))?.role).toBe("member");
    // ON CONFLICT updates role (re-add as admin).
    await repo.addMember(member(chan.id, u, "admin"));
    expect((await repo.getMember(chan.id, u))?.role).toBe("admin");

    await repo.addMember(member(chan.id, id.user(3)));
    const members = await repo.listMembers(chan.id);
    expect(members.map((m) => m.userId)).toEqual([id.user(2), id.user(3)].sort()); // ORDER BY user_id ASC

    expect(await repo.removeMember(chan.id, u)).toBe(true);
    expect(await repo.removeMember(chan.id, u)).toBe(false); // already gone -> no-op
    expect(await repo.getMember(chan.id, u)).toBeNull();
  });

  it("membershipsForUser returns every channel the user belongs to", async () => {
    const repo = makeRepo();
    const id = ns();
    const u = id.user(1);
    const c1 = channel({ id: id.chan(1), createdBy: u });
    const c2 = channel({ id: id.chan(2), createdBy: u });
    await repo.createChannel(c1);
    await repo.createChannel(c2);
    await repo.addMember(member(c1.id, u));
    await repo.addMember(member(c2.id, u));
    const rows = await repo.membershipsForUser(u);
    expect(rows.map((m) => m.channelId).sort()).toEqual([c1.id, c2.id]);
  });
});

describe("d1-repo: messages", () => {
  it("createMessage round-trips attachments (JSON) and threadRootId", async () => {
    const repo = makeRepo();
    const id = ns();
    const chan = channel({ id: id.chan(1), createdBy: id.user(1) });
    await repo.createChannel(chan);
    const root = message({ id: id.msg(1), channelId: chan.id, authorId: id.user(1) });
    await repo.createMessage(root);
    const reply = message({
      id: id.msg(2),
      channelId: chan.id,
      authorId: id.user(1),
      threadRootId: root.id,
      attachmentFileIds: ["file_a", "file_b"],
    });
    await repo.createMessage(reply);
    expect(await repo.getMessage(reply.id)).toEqual(reply);
    expect(await repo.getMessage("msg_missing")).toBeNull();
  });

  it("listMessages: newest-first history with beforeId cursor, ascending gap-fill, thread filter", async () => {
    const repo = makeRepo();
    const id = ns();
    const chan = channel({ id: id.chan(1), createdBy: id.user(1) });
    await repo.createChannel(chan);
    const m1 = message({ id: id.msg(1), channelId: chan.id, authorId: id.user(1) });
    const m2 = message({ id: id.msg(2), channelId: chan.id, authorId: id.user(1) });
    const m3 = message({ id: id.msg(3), channelId: chan.id, authorId: id.user(1) });
    const threadReply = message({ id: id.msg(4), channelId: chan.id, authorId: id.user(1), threadRootId: m1.id });
    for (const m of [m1, m2, m3, threadReply]) await repo.createMessage(m);

    // default desc history (newest id first) — main list is TOP-LEVEL only (reply excluded)
    const desc = await repo.listMessages({ channelId: chan.id, limit: 10 });
    expect(desc.map((m) => m.id)).toEqual([m3.id, m2.id, m1.id]);

    // cursor: id < beforeId, still desc
    const page = await repo.listMessages({ channelId: chan.id, beforeId: m3.id, limit: 10 });
    expect(page.map((m) => m.id)).toEqual([m2.id, m1.id]);

    // asc gap-fill: id > afterMessageId, ascending (still top-level only)
    const asc = await repo.listMessages({ channelId: chan.id, afterMessageId: m1.id, limit: 10 });
    expect(asc.map((m) => m.id)).toEqual([m2.id, m3.id]);

    // thread filter returns the reply
    const thread = await repo.listMessages({ channelId: chan.id, threadRootId: m1.id, limit: 10 });
    expect(thread.map((m) => m.id)).toEqual([threadReply.id]);

    // replyCounts: m1 has one reply; others have none
    const counts = await repo.replyCounts([m1.id, m2.id, m3.id]);
    expect(counts.get(m1.id)).toBe(1);
    expect(counts.get(m2.id)).toBeUndefined();

    // LIMIT is honored
    expect((await repo.listMessages({ channelId: chan.id, limit: 2 })).length).toBe(2);
  });

  it("updateMessage is optimistic-locked (edit + soft-delete)", async () => {
    const repo = makeRepo();
    const id = ns();
    const chan = channel({ id: id.chan(1), createdBy: id.user(1) });
    await repo.createChannel(chan);
    const m = message({ id: id.msg(1), channelId: chan.id, authorId: id.user(1), version: 1 });
    await repo.createMessage(m);

    const edited: MessageRow = { ...m, body: "edited", editedAt: AT, version: 2 };
    expect(await repo.updateMessage(edited, 999)).toBe(false);
    expect(await repo.updateMessage(edited, 1)).toBe(true);
    expect(await repo.getMessage(m.id)).toMatchObject({ body: "edited", editedAt: AT, version: 2 });

    const deleted: MessageRow = { ...edited, deletedAt: AT, version: 3, attachmentFileIds: [] };
    expect(await repo.updateMessage(deleted, 2)).toBe(true);
    expect(await repo.getMessage(m.id)).toMatchObject({ deletedAt: AT, version: 3 });
  });
});

describe("d1-repo: reactions", () => {
  it("add is idempotent, remove reports changes, reactionsFor groups + orders", async () => {
    const repo = makeRepo();
    const id = ns();
    const chan = channel({ id: id.chan(1), createdBy: id.user(1) });
    await repo.createChannel(chan);
    const m = message({ id: id.msg(1), channelId: chan.id, authorId: id.user(1) });
    await repo.createMessage(m);
    const [uA, uB] = [id.user(1), id.user(2)];

    expect(await repo.hasReaction(m.id, "👍", uA)).toBe(false);
    await repo.addReaction(m.id, "👍", uA, "2026-08-10T05:00:00.000Z");
    await repo.addReaction(m.id, "👍", uA, "2026-08-10T05:00:00.000Z"); // ON CONFLICT DO NOTHING
    await repo.addReaction(m.id, "👍", uB, "2026-08-10T05:00:01.000Z");
    await repo.addReaction(m.id, "🎉", uA, "2026-08-10T05:00:02.000Z");
    expect(await repo.hasReaction(m.id, "👍", uA)).toBe(true);

    const map = (await repo.reactionsFor([m.id])).get(m.id);
    expect(map).toEqual({ "👍": [uA, uB], "🎉": [uA] }); // grouped, ordered by created_at

    expect(await repo.removeReaction(m.id, "👍", uA)).toBe(true);
    expect(await repo.removeReaction(m.id, "👍", uA)).toBe(false); // already gone
    expect((await repo.reactionsFor([m.id])).get(m.id)).toEqual({ "👍": [uB], "🎉": [uA] });

    // empty input -> empty map (no IN () syntax error)
    expect((await repo.reactionsFor([])).size).toBe(0);
  });
});

describe("d1-repo: read state + unread", () => {
  it("setReadState upserts; countUnread respects cursor, own-author, and soft-delete", async () => {
    const repo = makeRepo();
    const id = ns();
    const chan = channel({ id: id.chan(1), createdBy: id.user(1) });
    await repo.createChannel(chan);
    const me = id.user(1);
    const other = id.user(2);

    const m1 = message({ id: id.msg(1), channelId: chan.id, authorId: other });
    const m2 = message({ id: id.msg(2), channelId: chan.id, authorId: other });
    const mine = message({ id: id.msg(3), channelId: chan.id, authorId: me });
    const gone = message({ id: id.msg(4), channelId: chan.id, authorId: other, deletedAt: AT });
    for (const m of [m1, m2, mine, gone]) await repo.createMessage(m);

    // never read -> all non-deleted messages by others count (mine + deleted excluded)
    expect(await repo.getReadState(chan.id, me)).toBeNull();
    expect(await repo.countUnread(chan.id, me, null)).toBe(2);

    // set cursor at m1 -> only m2 remains unread (mine & deleted still excluded)
    await repo.setReadState(chan.id, me, m1.id, AT);
    expect((await repo.getReadState(chan.id, me))?.lastReadMessageId).toBe(m1.id);
    expect(await repo.countUnread(chan.id, me, m1.id)).toBe(1);

    // upsert: advancing the cursor to m2 clears unread
    await repo.setReadState(chan.id, me, m2.id, AT);
    expect((await repo.getReadState(chan.id, me))?.lastReadMessageId).toBe(m2.id);
    expect(await repo.countUnread(chan.id, me, m2.id)).toBe(0);
  });
});

describe("d1-repo: pins", () => {
  it("addPin is idempotent; listPinnedMessages excludes tombstones, newest-first; removePin reports change", async () => {
    const repo = makeRepo();
    const id = ns();
    const chan = channel({ id: id.chan(1), createdBy: id.user(1) });
    await repo.createChannel(chan);
    const m1 = message({ id: id.msg(1), channelId: chan.id, authorId: id.user(1), body: "first" });
    const m2 = message({ id: id.msg(2), channelId: chan.id, authorId: id.user(1), body: "second" });
    const gone = message({ id: id.msg(3), channelId: chan.id, authorId: id.user(1), body: "deleted", deletedAt: AT });
    for (const m of [m1, m2, gone]) await repo.createMessage(m);

    expect(await repo.isPinned(chan.id, m1.id)).toBe(false);
    await repo.addPin(chan.id, m1.id, id.user(1), AT);
    await repo.addPin(chan.id, m1.id, id.user(1), AT); // ON CONFLICT DO NOTHING
    await repo.addPin(chan.id, m2.id, id.user(1), AT);
    await repo.addPin(chan.id, gone.id, id.user(1), AT); // pinned but tombstoned -> hidden
    expect(await repo.isPinned(chan.id, m1.id)).toBe(true);

    const pinned = await repo.listPinnedMessages(chan.id);
    expect(pinned.map((m) => m.id)).toEqual([m2.id, m1.id]); // id desc, tombstone excluded

    expect(await repo.removePin(chan.id, m1.id)).toBe(true);
    expect(await repo.removePin(chan.id, m1.id)).toBe(false); // already gone
    expect((await repo.listPinnedMessages(chan.id)).map((m) => m.id)).toEqual([m2.id]);
  });
});

describe("d1-repo: search", () => {
  it("matches body substring case-insensitively, scopes to readable channels, newest-first, bounded", async () => {
    const repo = makeRepo();
    const id = ns();
    const me = id.user(1);
    const pub = channel({ id: id.chan(1), visibility: "public", name: "general", createdBy: id.user(2) });
    const priv = channel({ id: id.chan(2), visibility: "private", name: "secret", createdBy: id.user(2) });
    await repo.createChannel(pub);
    await repo.createChannel(priv);
    // caller is a member of neither; public is still readable, private is not.
    const inPub = message({ id: id.msg(1), channelId: pub.id, authorId: id.user(2), body: "Deploy the ROCKET" });
    const inPubOther = message({ id: id.msg(2), channelId: pub.id, authorId: id.user(2), body: "lunch?" });
    const inPriv = message({ id: id.msg(3), channelId: priv.id, authorId: id.user(2), body: "rocket launch codes" });
    const tomb = message({ id: id.msg(4), channelId: pub.id, authorId: id.user(2), body: "rocket", deletedAt: AT });
    for (const m of [inPub, inPubOther, inPriv, tomb]) await repo.createMessage(m);

    // case-insensitive substring; private channel excluded; tombstone excluded
    const hits = await repo.searchMessages({ userId: me, text: "rocket", limit: 50 });
    expect(hits.map((h) => h.message.id)).toEqual([inPub.id]);
    expect(hits[0]!.channelName).toBe("general");
    expect(hits[0]!.channelType).toBe("topic");

    // when the caller joins the private channel it becomes searchable
    await repo.addMember(member(priv.id, me));
    const hits2 = await repo.searchMessages({ userId: me, text: "rocket", limit: 50 });
    expect(hits2.map((h) => h.message.id)).toEqual([inPriv.id, inPub.id]); // id desc

    // channelId scope + limit
    const scoped = await repo.searchMessages({ userId: me, text: "rocket", channelId: pub.id, limit: 50 });
    expect(scoped.map((h) => h.message.id)).toEqual([inPub.id]);
    const bounded = await repo.searchMessages({ userId: me, text: "rocket", limit: 1 });
    expect(bounded).toHaveLength(1);
  });
});

describe("d1-repo: deletion policy + hard delete", () => {
  it("getDeletionPolicy is null until set; setDeletionPolicy is version-locked (real SQL)", async () => {
    const repo = makeRepo();
    const org = `org_${caseSeq}_${Date.now()}`;

    expect(await repo.getDeletionPolicy(org)).toBeNull();

    // first write requires expectedVersion 0
    expect(await repo.setDeletionPolicy({ orgId: org, policy: { member: "tombstone", moderator: "hard", protectReacted: false }, expectedVersion: 5, updatedBy: "u1", at: AT })).toBeNull();
    const first = await repo.setDeletionPolicy({ orgId: org, policy: { member: "tombstone", moderator: "hard", protectReacted: true }, expectedVersion: 0, updatedBy: "u1", at: AT });
    expect(first).toEqual({ version: 1 });
    // protect_reacted round-trips (stored as 0/1, read back as boolean)
    expect(await repo.getDeletionPolicy(org)).toEqual({ policy: { member: "tombstone", moderator: "hard", protectReacted: true }, version: 1 });

    // a second write with expectedVersion 0 conflicts (row already exists)
    expect(await repo.setDeletionPolicy({ orgId: org, policy: { member: "hard", moderator: "hard", protectReacted: true }, expectedVersion: 0, updatedBy: "u1", at: AT })).toBeNull();
    // stale version conflicts
    expect(await repo.setDeletionPolicy({ orgId: org, policy: { member: "hard", moderator: "hard", protectReacted: true }, expectedVersion: 9, updatedBy: "u1", at: AT })).toBeNull();
    // correct version advances; protectReacted can be turned back off
    const second = await repo.setDeletionPolicy({ orgId: org, policy: { member: "hard", moderator: "tombstone", protectReacted: false }, expectedVersion: 1, updatedBy: "u2", at: AT });
    expect(second).toEqual({ version: 2 });
    expect(await repo.getDeletionPolicy(org)).toEqual({ policy: { member: "hard", moderator: "tombstone", protectReacted: false }, version: 2 });
  });

  it("messageHasReactions reflects presence of any reaction (real SQL)", async () => {
    const repo = makeRepo();
    const id = ns();
    const chan = channel({ id: id.chan(1), createdBy: id.user(1) });
    await repo.createChannel(chan);
    const m = message({ id: id.msg(1), channelId: chan.id, authorId: id.user(1) });
    await repo.createMessage(m);
    expect(await repo.messageHasReactions(m.id)).toBe(false);
    await repo.addReaction(m.id, "👍", id.user(2), AT);
    expect(await repo.messageHasReactions(m.id)).toBe(true);
    await repo.removeReaction(m.id, "👍", id.user(2));
    expect(await repo.messageHasReactions(m.id)).toBe(false);
  });

  it("hardDeleteMessage physically removes the message, its reactions/pins and thread replies", async () => {
    const repo = makeRepo();
    const id = ns();
    const chan = channel({ id: id.chan(1), createdBy: id.user(1) });
    await repo.createChannel(chan);
    const root = message({ id: id.msg(1), channelId: chan.id, authorId: id.user(1) });
    const reply = message({ id: id.msg(2), channelId: chan.id, authorId: id.user(1), threadRootId: root.id });
    const other = message({ id: id.msg(3), channelId: chan.id, authorId: id.user(1) });
    for (const m of [root, reply, other]) await repo.createMessage(m);
    await repo.addReaction(root.id, "👍", id.user(2), AT);
    await repo.addReaction(reply.id, "🎉", id.user(2), AT);
    await repo.addPin(chan.id, root.id, id.user(1), AT);

    await repo.hardDeleteMessage(root.id);

    expect(await repo.getMessage(root.id)).toBeNull();
    expect(await repo.getMessage(reply.id)).toBeNull(); // thread reply cascaded
    expect(await repo.getMessage(other.id)).not.toBeNull(); // unrelated message intact
    expect((await repo.reactionsFor([root.id, reply.id])).size).toBe(0);
    expect(await repo.isPinned(chan.id, root.id)).toBe(false);
    // gone from the timeline entirely (no tombstone row)
    const list = await repo.listMessages({ channelId: chan.id, limit: 50 });
    expect(list.map((m) => m.id)).toEqual([other.id]);
  });
});
