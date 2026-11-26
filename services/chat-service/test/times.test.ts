// times channels in Dub chat (#850): naming, planning, preview / bulk / event path. Roster,
// records and existing channel names come from an in-memory SQLite built from the real
// migrations; channels are created through the real ChatService (in-memory repo).
import { beforeEach, describe, expect, it } from "vitest";
import { chat } from "@dub/types";
import { TIMES_BULK_BATCH, Times, planTimesName, readTimesConfig } from "../src/times";
import { ChatService } from "../src/service";
import type { ChannelRow } from "../src/types";
import { makeImportD1, type RawDb } from "./import-d1";
import { ALL_CHAT_KEYS, call, createApp, fakeAuthz, makeDeps } from "./harness";

const ORG = "org_devhub";

let raw: RawDb;
let times: Times;
let deps: ReturnType<typeof makeDeps>;
let svc: ChatService;
let d1: ReturnType<typeof makeImportD1>["d1"];

function addMember(id: string, email: string, name: string, status = "active") {
  raw.exec(
    `INSERT INTO identity_users (id, org_id, email, display_name, status, created_at, updated_at) VALUES ('${id}', '${ORG}', '${email}', '${name}', '${status}', 'x', 'x');`,
  );
}

function addChannel(id: string, name: string, createdBy: string, archived = false, type = "topic") {
  raw.exec(
    `INSERT INTO chat_channels (id, type, visibility, name, created_by, archived_at, version, created_at, updated_at) VALUES ('${id}', '${type}', 'public', '${name}', '${createdBy}', ${archived ? "'x'" : "NULL"}, 1, 'x', 'x');`,
  );
}

const build = (env: Parameters<typeof readTimesConfig>[0] = {}) =>
  new Times({ db: d1, orgId: ORG, config: readTimesConfig(env), now: () => "2026-11-26T00:00:00.000Z" });

beforeEach(() => {
  const made = makeImportD1();
  raw = made.raw;
  d1 = made.d1;
  raw.exec(`INSERT OR IGNORE INTO identity_orgs (id, name, created_at) VALUES ('${ORG}', 'DevHub', 'x');`);
  times = build();
  // Members hold no chat:create_private: the system create must not ask for it.
  deps = makeDeps({ authz: fakeAuthz(new Set(["app:chat:view", "chat:create"])) });
  svc = new ChatService(deps);
  addMember("usr_alice", "alice@example.com", "Alice Smith");
  addMember("usr_bob", "bob@example.com", "田中 ボブ");
});

/** The in-memory repo's channel rows (private field; test-only peek). */
const chans = (d: ReturnType<typeof makeDeps>) => (d.repo as unknown as { channels: Map<string, ChannelRow> }).channels;
const rows = () => raw.prepare("SELECT user_id, channel_name, channel_id, status FROM chat_times ORDER BY user_id").all();

describe("naming", () => {
  it("slugs to a lowercase name and keeps Japanese", () => {
    expect(chat.timesSlug("Alice Smith")).toBe("alice-smith");
    expect(chat.timesSlug("  Ｔａｒｏ．Ｙ  ")).toBe("taro-y");
    expect(chat.timesSlug("田中 ボブ")).toBe("田中-ボブ");
    expect(chat.timesSlug("a__b!!c--")).toBe("a__b-c");
  });
  it("uses the Dub display name, else the email local part", () => {
    expect(chat.timesBaseName("times-", { displayName: "Dub Name", email: "x.y@example.com" })).toBe("times-dub-name");
    expect(chat.timesBaseName("times-", { displayName: "!!!", email: "x.y@example.com" })).toBe("times-x-y");
    expect(chat.timesBaseName("times-", { displayName: "a".repeat(200), email: "e@x" }).length).toBeLessThanOrEqual(77);
  });
  it("config defaults (public, auto, times-) and env overrides", () => {
    expect(readTimesConfig({})).toEqual({ prefix: "times-", isPrivate: false, autoCreate: true });
    expect(readTimesConfig({ CHAT_TIMES_PREFIX: "Times_", CHAT_TIMES_PRIVATE: "true", CHAT_TIMES_AUTO: "false" })).toEqual({
      prefix: "times_",
      isPrivate: true,
      autoCreate: false,
    });
  });
  it("plans: own live channel is adopted; someone else's / archived / recorded get a suffix", () => {
    const chans = new Map([
      ["times-a", [{ id: "C1", createdBy: "u1", archived: true }]],
      ["times-b", [{ id: "C2", createdBy: "u1", archived: false }]],
      ["times-d", [{ id: "C3", createdBy: "u2", archived: false }]],
    ]);
    expect(planTimesName("times-a", "u1", chans, new Set())).toEqual({ kind: "create", name: "times-a-2" });
    expect(planTimesName("times-b", "u1", chans, new Set())).toEqual({ kind: "existing", name: "times-b", channelId: "C2" });
    expect(planTimesName("times-d", "u1", chans, new Set())).toEqual({ kind: "create", name: "times-d-2" });
    expect(planTimesName("times-c", "u1", chans, new Set(["times-c"]))).toEqual({ kind: "create", name: "times-c-2" });
  });
});

describe("preview (dry run)", () => {
  it("lists planned names without any write", async () => {
    addChannel("chan_ex", "times-alice-smith", "usr_alice");
    const p = await times.preview();
    expect(p.recordedCount).toBe(0);
    expect(p.items.map((i) => [i.userId, i.channelName, i.status])).toEqual([
      ["usr_alice", "times-alice-smith", "existing"],
      ["usr_bob", "times-田中-ボブ", "planned"],
    ]);
    expect(chans(deps).size).toBe(0);
    expect(rows()).toEqual([]);
  });

  it("skips Slack-import placeholders and inactive members; ignores DMs", async () => {
    addMember("usr_ph", "slack-u1@slack-import.invalid", "Ghost");
    addMember("usr_inv", "inv@example.com", "Invited", "invited");
    addChannel("chan_dm", "times-alice-smith", "usr_bob", false, "dm");
    const items = (await times.preview()).items;
    expect(items.map((i) => i.userId)).toEqual(["usr_alice", "usr_bob"]);
    expect(items[0]!.channelName).toBe("times-alice-smith");
  });
});

describe("bulk", () => {
  it("creates through ChatService (owner = member, public), records, and is idempotent", async () => {
    const r = await times.bulk(svc, "req_1");
    expect(r.results.map((i) => [i.userId, i.status, i.channelName])).toEqual([
      ["usr_alice", "created", "times-alice-smith"],
      ["usr_bob", "created", "times-田中-ボブ"],
    ]);
    expect(r.remaining).toBe(0);
    const ch = [...chans(deps).values()];
    expect(ch).toHaveLength(2);
    const alice = ch.find((c) => c.name === "times-alice-smith")!;
    expect(alice).toMatchObject({ type: "topic", visibility: "public", createdBy: "usr_alice" });
    expect(await deps.repo.listMembers(alice.id)).toEqual([expect.objectContaining({ userId: "usr_alice", role: "admin" })]);
    expect(rows()).toEqual([
      { user_id: "usr_alice", channel_name: "times-alice-smith", channel_id: alice.id, status: "created" },
      expect.objectContaining({ user_id: "usr_bob", status: "created" }),
    ]);
    expect(deps.publisher.events.some((e: { name: string }) => e.name === "chat.channel.created")).toBe(true);
    expect(await times.bulk(svc, "req_2")).toEqual({ results: [], remaining: 0 });
    expect(chans(deps).size).toBe(2);
    expect((await times.preview()).recordedCount).toBe(2);
  });

  it("records the member's own existing channel instead of creating one", async () => {
    addChannel("chan_ex", "times-alice-smith", "usr_alice");
    const r = await times.bulk(svc, "req", ["usr_alice"]);
    expect(r.results[0]).toMatchObject({ status: "existing", channelId: "chan_ex" });
    expect(chans(deps).size).toBe(0);
  });

  it("collisions -> -2 / -3: another person's channel and same-slug members", async () => {
    addChannel("chan_other", "times-alice-smith", "usr_someone");
    addMember("usr_alice2", "alice2@example.com", "Alice Smith");
    const r = await times.bulk(svc, "req");
    const names = r.results.filter((i) => i.status === "created").map((i) => i.channelName).sort();
    expect(names).toEqual(["times-alice-smith-2", "times-alice-smith-3", "times-田中-ボブ"]);
  });

  it("a create failure leaves no reservation and is reported per member", async () => {
    const failing = { createChannel: () => Promise.reject(new Error("boom")) };
    const r = await times.bulk(failing, "req", ["usr_alice"]);
    expect(r.results[0]).toMatchObject({ status: "failed", error: "boom" });
    expect(rows()).toEqual([]);
  });

  it("processes at most one batch per call", async () => {
    for (let i = 0; i < TIMES_BULK_BATCH + 3; i++) addMember(`usr_m${i}`, `m${i}@example.com`, `Member ${i}`);
    const first = await times.bulk(svc, "req");
    expect(first.results.filter((i) => i.status === "created")).toHaveLength(TIMES_BULK_BATCH);
    expect(first.remaining).toBe(5);
    const second = await times.bulk(svc, "req");
    expect(second.remaining).toBe(0);
    expect(rows()).toHaveLength(TIMES_BULK_BATCH + 5);
  });

  it("uses private channels when configured (no chat:create_private needed on the member)", async () => {
    await build({ CHAT_TIMES_PRIVATE: "true" }).bulk(svc, "req", ["usr_alice"]);
    expect([...chans(deps).values()][0]).toMatchObject({ visibility: "private", createdBy: "usr_alice" });
  });
});

describe("event path (identity.user.activated)", () => {
  it("creates once for an active member; unknown user -> no-op", async () => {
    expect(await times.ensureForUser(svc, "req", "usr_alice")).toMatchObject({ status: "created" });
    expect(await times.ensureForUser(svc, "req", "usr_alice")).toMatchObject({ status: "recorded" });
    expect(await times.ensureForUser(svc, "req", "usr_missing")).toBeNull();
    expect(chans(deps).size).toBe(1);
  });

  const envelope = (userId: string) => ({
    name: "identity.user.activated",
    version: 1,
    id: "evt_1",
    occurredAt: "x",
    requestId: "r",
    actorId: null,
    payload: { userId, orgId: ORG, email: "alice@example.com", displayName: "Alice" },
  });

  it("POST /internal/events-async is INTERNAL and creates the channel", async () => {
    const d = makeDeps({ times });
    const app = createApp(d);
    expect((await call(app, "POST", "/internal/events-async", { body: envelope("usr_alice") })).status).toBe(403);
    const ok = await call(app, "POST", "/internal/events-async", { internal: true, userId: null, body: envelope("usr_alice") });
    expect(ok.status).toBe(200);
    expect(ok.json.item).toMatchObject({ status: "created", channelName: "times-alice-smith" });
    expect([...chans(d).values()][0]).toMatchObject({ createdBy: "usr_alice" });
    const other = await call(app, "POST", "/internal/events-async", { internal: true, userId: null, body: { ...envelope("usr_alice"), name: "task.created" } });
    expect(other.json).toMatchObject({ ignored: true });
  });

  it("respects CHAT_TIMES_AUTO=false", async () => {
    const d = makeDeps({ times: build({ CHAT_TIMES_AUTO: "false" }) });
    const r = await call(createApp(d), "POST", "/internal/events-async", { internal: true, userId: null, body: envelope("usr_alice") });
    expect(r.json).toMatchObject({ skipped: "disabled" });
    expect(chans(d).size).toBe(0);
  });

  it("a create failure surfaces as 5xx (the drain retries) and leaves no record", async () => {
    const d = makeDeps({ times });
    d.repo.createChannelWithMembers = () => Promise.reject(new Error("d1 down"));
    const r = await call(createApp(d), "POST", "/internal/events-async", { internal: true, userId: null, body: envelope("usr_alice") });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(rows()).toEqual([]);
  });
});

describe("admin routes", () => {
  const KEYS: typeof ALL_CHAT_KEYS = [...ALL_CHAT_KEYS, "chat:times"];
  it("need chat:times", async () => {
    const noKey = createApp(makeDeps({ times, authz: fakeAuthz(new Set(ALL_CHAT_KEYS)) }));
    expect((await call(noKey, "GET", "/chat/times/preview", { userId: "usr_admin" })).status).toBe(403);
    const app = createApp(makeDeps({ times, authz: fakeAuthz(new Set(KEYS)) }));
    const p = await call(app, "GET", "/chat/times/preview", { userId: "usr_admin" });
    expect(p.status).toBe(200);
    expect(p.json.items).toHaveLength(2);
    const b = await call(app, "POST", "/chat/times/bulk", { userId: "usr_admin", body: { userIds: ["usr_bob"] } });
    expect(b.json.results).toEqual([expect.objectContaining({ userId: "usr_bob", status: "created" })]);
    expect((await call(app, "POST", "/chat/times/bulk", { userId: "usr_admin", body: { userIds: [1] } })).status).toBe(400);
  });
  it("412 when not configured", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(new Set(KEYS)) }));
    expect((await call(app, "GET", "/chat/times/preview", { userId: "usr_admin" })).status).toBe(412);
  });
});
