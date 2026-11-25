// Slack times channels (#850): naming, planning, preview / bulk / event path against a FAKE
// Slack client (never the network) and an in-memory SQLite built from the real migrations.
import { beforeEach, describe, expect, it } from "vitest";
import { type SlackChannel, type SlackUser, SlackApiError, createSlackClient } from "@dub/slack-import";
import {
  SLACK_TIMES_BULK_BATCH,
  SlackTimes,
  type SlackTimesClient,
  baseTimesName,
  planTimesName,
  readSlackTimesConfig,
  slugForChannel,
} from "../src/slack-times";
import { makeImportD1, type RawDb } from "./import-d1";
import { ALL_CHAT_KEYS, call, createApp, fakeAuthz, makeDeps } from "./harness";

const ORG = "org_devhub";

class FakeSlack implements SlackTimesClient {
  users: SlackUser[] = [];
  channels: (SlackChannel & { is_archived?: boolean })[] = [];
  created: { name: string; isPrivate: boolean }[] = [];
  invites: { channel: string; users: readonly string[] }[] = [];
  /** Names Slack refuses with name_taken although not listed (e.g. an invisible private channel). */
  hiddenTaken = new Set<string>();
  failCreate: string | null = null;
  failInvite: string | null = null;

  async listUsers() {
    return this.users;
  }
  async listChannels() {
    return this.channels;
  }
  async lookupUserByEmail(email: string) {
    return this.users.find((u) => u.profile?.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }
  async createChannel(name: string, isPrivate: boolean) {
    if (this.failCreate) throw new SlackApiError("conversations.create", this.failCreate, null, this.failCreate === "missing_scope" ? "channels:manage" : null);
    if (this.hiddenTaken.has(name) || this.channels.some((c) => c.name === name)) throw new SlackApiError("conversations.create", "name_taken");
    const ch = { id: `C_${this.channels.length + 1}`, name, created: 0, is_private: isPrivate };
    this.channels.push(ch);
    this.created.push({ name, isPrivate });
    return ch;
  }
  async inviteToChannel(channel: string, users: readonly string[]) {
    if (this.failInvite) throw new SlackApiError("conversations.invite", this.failInvite);
    this.invites.push({ channel, users });
  }
}

let raw: RawDb;
let slack: FakeSlack;
let times: SlackTimes;

function addMember(id: string, email: string, name: string, status = "active") {
  raw.exec(
    `INSERT INTO identity_users (id, org_id, email, display_name, status, created_at, updated_at) VALUES ('${id}', '${ORG}', '${email}', '${name}', '${status}', 'x', 'x');`,
  );
}

function build(over: Partial<ConstructorParameters<typeof SlackTimes>[0]> = {}) {
  const made = makeImportD1();
  return new SlackTimes({ db: made.d1, slack, orgId: ORG, config: readSlackTimesConfig({}), now: () => "2026-11-26T00:00:00.000Z", ...over });
}

beforeEach(() => {
  slack = new FakeSlack();
  const made = makeImportD1();
  raw = made.raw;
  raw.exec(`INSERT OR IGNORE INTO identity_orgs (id, name, created_at) VALUES ('${ORG}', 'DevHub', 'x');`);
  times = new SlackTimes({ db: made.d1, slack, orgId: ORG, config: readSlackTimesConfig({}), now: () => "2026-11-26T00:00:00.000Z" });
  addMember("usr_alice", "alice@example.com", "Alice");
  addMember("usr_bob", "bob@example.com", "Bob");
  slack.users = [
    { id: "U_ALICE", name: "alice", profile: { email: "Alice@Example.com", display_name: "Alice Smith" } },
    { id: "U_BOB", name: "bob", profile: { email: "bob@example.com", display_name: "" , real_name: "ボブ 田中" } },
    { id: "U_BOT", name: "bot", is_bot: true, profile: { email: "bot@example.com" } },
  ];
});

const rows = () => raw.prepare("SELECT user_id, channel_name, slack_channel_id, status FROM chat_slack_times ORDER BY user_id").all();

describe("naming", () => {
  it("slugs to a Slack-safe lowercase name and keeps non-Latin letters", () => {
    expect(slugForChannel("Alice Smith")).toBe("alice-smith");
    expect(slugForChannel("  Ｔａｒｏ．Ｙ  ")).toBe("taro-y");
    expect(slugForChannel("ボブ 田中")).toBe("ボブ-田中");
    expect(slugForChannel("a__b!!c--")).toBe("a__b-c");
  });
  it("prefers Slack display name, then real name, username, Dub name, email", () => {
    const m = { displayName: "Dub Name", email: "x.y@example.com" };
    expect(baseTimesName("times-", m, { id: "U", profile: { display_name: "Disp" } })).toBe("times-disp");
    expect(baseTimesName("times-", m, { id: "U", name: "user", profile: { display_name: "", real_name: "Real" } })).toBe("times-real");
    expect(baseTimesName("times-", m, null)).toBe("times-dub-name");
    expect(baseTimesName("times-", { displayName: "!!!", email: "x.y@example.com" }, null)).toBe("times-x-y");
    expect(baseTimesName("times-", { displayName: "a".repeat(200), email: "e@x" }, null).length).toBeLessThanOrEqual(77);
  });
  it("config defaults (public, auto, times-) and env overrides", () => {
    expect(readSlackTimesConfig({})).toEqual({ prefix: "times-", isPrivate: false, autoCreate: true });
    expect(readSlackTimesConfig({ SLACK_TIMES_PREFIX: "Times_", SLACK_TIMES_PRIVATE: "true", SLACK_TIMES_AUTO: "false" })).toEqual({
      prefix: "times_",
      isPrivate: true,
      autoCreate: false,
    });
  });
  it("plans: existing live channel is adopted, archived / taken-by-others get a suffix", () => {
    const chans = new Map([
      ["times-a", { id: "C1", archived: true }],
      ["times-b", { id: "C2", archived: false }],
    ]);
    expect(planTimesName("times-a", chans, new Set())).toEqual({ kind: "create", name: "times-a-2" });
    expect(planTimesName("times-b", chans, new Set())).toEqual({ kind: "existing", name: "times-b", channelId: "C2" });
    expect(planTimesName("times-c", chans, new Set(["times-c"]))).toEqual({ kind: "create", name: "times-c-2" });
  });
});

describe("preview (dry run)", () => {
  it("lists planned names without any Slack write", async () => {
    addMember("usr_carol", "carol@example.com", "Carol");
    slack.channels = [{ id: "C_EX", name: "times-alice-smith", created: 0 }];
    const p = await times.preview();
    expect(p.recordedCount).toBe(0);
    expect(p.items.map((i) => [i.userId, i.channelName, i.status])).toEqual([
      ["usr_alice", "times-alice-smith", "existing"],
      ["usr_bob", "times-ボブ-田中", "planned"],
      ["usr_carol", null, "no_slack_account"],
    ]);
    expect(slack.created).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("skips Slack-import placeholders and inactive members", async () => {
    addMember("usr_ph", "slack-u1@slack-import.invalid", "Ghost");
    addMember("usr_inv", "inv@example.com", "Invited", "invited");
    const ids = (await times.preview()).items.map((i) => i.userId);
    expect(ids).not.toContain("usr_ph");
    expect(ids).not.toContain("usr_inv");
  });
});

describe("bulk", () => {
  it("creates + invites, records, and is idempotent", async () => {
    const r = await times.bulk();
    expect(r.results.map((i) => [i.userId, i.status, i.channelName])).toEqual([
      ["usr_alice", "created", "times-alice-smith"],
      ["usr_bob", "created", "times-ボブ-田中"],
    ]);
    expect(r.remaining).toBe(0);
    expect(slack.created.every((c) => c.isPrivate === false)).toBe(true);
    expect(slack.invites.map((i) => i.users)).toEqual([["U_ALICE"], ["U_BOB"]]);
    expect(rows()).toHaveLength(2);
    expect(await times.bulk()).toEqual({ results: [], remaining: 0 });
    expect(slack.created).toHaveLength(2);
    expect((await times.preview()).recordedCount).toBe(2);
  });

  it("records an existing channel instead of creating one", async () => {
    slack.channels = [{ id: "C_EX", name: "times-alice-smith", created: 0 }];
    const r = await times.bulk(["usr_alice"]);
    expect(r.results[0]).toMatchObject({ status: "existing", slackChannelId: "C_EX" });
    expect(slack.created).toEqual([]);
  });

  it("name_taken -> next suffix; same-slug members do not collide", async () => {
    slack.hiddenTaken.add("times-alice-smith");
    addMember("usr_alice2", "alice2@example.com", "Alice 2");
    slack.users.push({ id: "U_A2", name: "alice2", profile: { email: "alice2@example.com", display_name: "Alice Smith" } });
    const r = await times.bulk();
    const names = r.results.filter((i) => i.status === "created").map((i) => i.channelName).sort();
    expect(names).toEqual(["times-alice-smith-2", "times-alice-smith-3", "times-ボブ-田中"]);
  });

  it("missing_scope -> 412 naming every needed scope", async () => {
    slack.failCreate = "missing_scope";
    const err = await times.bulk().catch((e) => e);
    expect(err.status).toBe(412);
    expect(err.details.reason).toBe("slack_missing_scope");
    expect(err.details.neededScopes).toEqual(expect.arrayContaining(["channels:manage", "channels:write.invites", "users:read.email"]));
    expect(err.message).toContain("channels:manage");
    expect(rows()).toEqual([]);
  });

  it("an invite failure keeps the created channel recorded and reports it", async () => {
    slack.failInvite = "missing_scope";
    const r = await times.bulk(["usr_alice"]);
    expect(r.results[0]).toMatchObject({ status: "failed", slackChannelId: "C_1" });
    expect(r.results[0]!.error).toContain("channels:write.invites");
    expect(rows()).toHaveLength(1);
  });

  it("processes at most one batch per call", async () => {
    for (let i = 0; i < SLACK_TIMES_BULK_BATCH + 3; i++) {
      addMember(`usr_m${i}`, `m${i}@example.com`, `Member ${i}`);
      slack.users.push({ id: `U_M${i}`, name: `m${i}`, profile: { email: `m${i}@example.com` } });
    }
    const first = await times.bulk();
    expect(first.results.filter((i) => i.status === "created")).toHaveLength(SLACK_TIMES_BULK_BATCH);
    expect(first.remaining).toBe(5);
    const second = await times.bulk();
    expect(second.remaining).toBe(0);
    expect(rows()).toHaveLength(SLACK_TIMES_BULK_BATCH + 5);
  });

  it("uses private channels when configured", async () => {
    const t = new SlackTimes({ ...(times as unknown as { d: ConstructorParameters<typeof SlackTimes>[0] }).d, config: readSlackTimesConfig({ SLACK_TIMES_PRIVATE: "true" }) });
    await t.bulk(["usr_alice"]);
    expect(slack.created).toEqual([{ name: "times-alice-smith", isPrivate: true }]);
  });
});

describe("event path (identity.user.activated)", () => {
  it("creates once for an active member; no Slack account / unknown user -> no-op", async () => {
    expect(await times.ensureForUser("usr_alice")).toMatchObject({ status: "created" });
    expect(await times.ensureForUser("usr_alice")).toMatchObject({ status: "recorded" });
    addMember("usr_nos", "nos@example.com", "No Slack");
    expect(await times.ensureForUser("usr_nos")).toMatchObject({ status: "no_slack_account" });
    expect(await times.ensureForUser("usr_missing")).toBeNull();
    expect(slack.created).toHaveLength(1);
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
    const app = createApp(makeDeps({ slackTimes: times }));
    expect((await call(app, "POST", "/internal/events-async", { body: envelope("usr_alice") })).status).toBe(403);
    const ok = await call(app, "POST", "/internal/events-async", { internal: true, userId: null, body: envelope("usr_alice") });
    expect(ok.status).toBe(200);
    expect(slack.created).toHaveLength(1);
    const other = await call(app, "POST", "/internal/events-async", { internal: true, userId: null, body: { ...envelope("usr_alice"), name: "task.created" } });
    expect(other.json).toMatchObject({ ignored: true });
  });

  it("acks (no retry loop) on missing scope; respects SLACK_TIMES_AUTO=false", async () => {
    slack.failCreate = "missing_scope";
    const app = createApp(makeDeps({ slackTimes: times }));
    const r = await call(app, "POST", "/internal/events-async", { internal: true, userId: null, body: envelope("usr_alice") });
    expect(r.status).toBe(200);
    expect(r.json.skipped).toMatch(/precondition/i);
    slack.failCreate = null;
    const off = new SlackTimes({ ...(times as unknown as { d: ConstructorParameters<typeof SlackTimes>[0] }).d, config: readSlackTimesConfig({ SLACK_TIMES_AUTO: "false" }) });
    const r2 = await call(createApp(makeDeps({ slackTimes: off })), "POST", "/internal/events-async", { internal: true, userId: null, body: envelope("usr_alice") });
    expect(r2.json).toMatchObject({ skipped: "disabled" });
    expect(slack.created).toEqual([]);
  });

  it("a Slack 429 surfaces as a retryable error (the drain retries)", async () => {
    slack.failCreate = "rate_limited";
    const app = createApp(makeDeps({ slackTimes: times }));
    const r = await call(app, "POST", "/internal/events-async", { internal: true, userId: null, body: envelope("usr_alice") });
    expect(r.status).toBe(429);
  });
});

describe("admin routes", () => {
  const KEYS: typeof ALL_CHAT_KEYS = [...ALL_CHAT_KEYS, "chat:slack_times"];
  it("need chat:slack_times", async () => {
    const noKey = createApp(makeDeps({ slackTimes: times, authz: fakeAuthz(new Set(ALL_CHAT_KEYS)) }));
    expect((await call(noKey, "GET", "/chat/slack-times/preview", { userId: "usr_admin" })).status).toBe(403);
    const app = createApp(makeDeps({ slackTimes: times, authz: fakeAuthz(new Set(KEYS)) }));
    const p = await call(app, "GET", "/chat/slack-times/preview", { userId: "usr_admin" });
    expect(p.status).toBe(200);
    expect(p.json.items).toHaveLength(2);
    const b = await call(app, "POST", "/chat/slack-times/bulk", { userId: "usr_admin", body: { userIds: ["usr_bob"] } });
    expect(b.json.results).toHaveLength(1);
    expect((await call(app, "POST", "/chat/slack-times/bulk", { userId: "usr_admin", body: { userIds: [1] } })).status).toBe(400);
  });
  it("412 when SLACK_BOT_TOKEN is absent", async () => {
    const app = createApp(makeDeps({ slackTimes: build({ slack: null }), authz: fakeAuthz(new Set(KEYS)) }));
    expect((await call(app, "GET", "/chat/slack-times/preview", { userId: "usr_admin" })).status).toBe(412);
  });
});

describe("Slack client (fake fetch, never the network)", () => {
  it("POSTs conversations.create form-encoded and surfaces `needed` on missing_scope", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("conversations.create")) return new Response(JSON.stringify({ ok: true, channel: { id: "C9", name: "times-x" } }));
      if (url.includes("users.lookupByEmail")) return new Response(JSON.stringify({ ok: false, error: "users_not_found" }));
      return new Response(JSON.stringify({ ok: false, error: "missing_scope", needed: "channels:write.invites" }));
    }) as unknown as typeof fetch;
    const c = createSlackClient({ token: "xoxb-test", fetchImpl, maxRetries: 0 });
    expect(await c.createChannel("times-x", false)).toMatchObject({ id: "C9" });
    expect(calls[0]!.init?.method).toBe("POST");
    expect(String(calls[0]!.init?.body)).toBe("name=times-x&is_private=false");
    expect(await c.lookupUserByEmail("a@b.c")).toBeNull();
    const err = await c.inviteToChannel("C9", ["U1"]).catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.needed).toBe("channels:write.invites");
  });
});
