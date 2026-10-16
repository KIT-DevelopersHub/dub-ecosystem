// In-app Slack channel import (src/slack-import.ts): drives the REAL step loop against a fake
// Slack client and an in-memory SQLite built from the real physical migrations.
import { beforeEach, describe, expect, it } from "vitest";
import {
  type SlackBookmark,
  type SlackChannel,
  type SlackClient,
  type SlackMessage,
  type SlackUser,
  SlackApiError,
  bookmarkMessageIdFor,
  channelIdFor,
  messageIdFor,
  placeholderUserIdFor,
} from "@dub/slack-import";
import { MAX_FILE_BYTES, SlackImporter, type AttachmentBucket, type SlackImportJob, type SlackImporterDeps } from "../src/slack-import";
import { count, makeImportD1, type RawDb } from "./import-d1";
import { ALL_CHAT_KEYS, call, createApp, fakeAuthz, makeDeps } from "./harness";

const ORG = "org_devhub";
const ADMIN = "usr_admin";
const ALICE = "usr_alice";

const CHANNEL: SlackChannel = {
  id: "C_GEN",
  name: "general",
  created: 1_700_000_000,
  is_private: false,
  is_member: false,
  topic: { value: "雑談" },
  creator: "U_ALICE",
  num_members: 4,
};
const OTHER: SlackChannel = { id: "C_PRIV", name: "secret", created: 1_700_000_000, is_private: true, is_member: true };

const USERS: SlackUser[] = [
  { id: "U_ALICE", name: "alice", profile: { email: "Alice@Example.com", display_name: "アリス" } },
  { id: "U_GONE", name: "gone", real_name: "退職者", profile: { email: "gone@example.com" } },
  { id: "U_BOT", name: "deploybot", is_bot: true, profile: { real_name: "Deploy Bot" } },
];

const ts = (n: number): string => `${1_760_000_000 + n}.000100`;
const ROOT = ts(10);
const OLD_ROOT = "1600000000.000100"; // outside the 90-day window: never in history

function history(): SlackMessage[] {
  const filler: SlackMessage[] = Array.from({ length: 55 }, (_, i) => ({ ts: ts(100 + i), user: "U_ALICE", text: `filler ${i}` }));
  return [
    { ts: ts(1), user: "U_ALICE", text: "hello <@U_GONE> and <@U_EXT>", reactions: [{ name: "+1", users: ["U_ALICE", "U_GONE", "U_EXT"] }, { name: "partyparrot", users: ["U_ALICE"] }] },
    { ts: ts(2), user: "U_GONE", text: "pinned", pinned_to: ["C_GEN"] },
    { ts: ts(3), bot_id: "B_HOOK", bot_profile: { name: "GitHub" }, subtype: "bot_message", text: "", attachments: [{ title: "PR merged", text: "body" }] },
    {
      ts: ts(4),
      user: "U_ALICE",
      text: "files",
      files: [
        { id: "F_OK", name: "a.png", mimetype: "image/png", size: 10, url_private: "https://files/ok" },
        { id: "F_GONE", mode: "tombstone" },
        { id: "F_BIG", name: "big.zip", size: MAX_FILE_BYTES + 1, url_private: "https://files/big" },
        { id: "F_404", name: "lost.txt", size: 5, url_private: "https://files/404" },
      ],
    },
    { ts: ROOT, user: "U_ALICE", text: "thread root", thread_ts: ROOT, reply_count: 2 },
    // broadcast of a reply to ROOT: written top-level by history, attached by the threads pass
    { ts: ts(12), user: "U_GONE", text: "also sent to channel", thread_ts: ROOT, subtype: "thread_broadcast" },
    // broadcast of a reply whose root is beyond 90 days: stays top-level
    { ts: ts(13), user: "U_ALICE", text: "orphan broadcast", thread_ts: OLD_ROOT, subtype: "thread_broadcast" },
    { ts: ts(20), user: "U_ALICE", text: "deleted root", thread_ts: ts(20), reply_count: 1 },
    ...filler,
  ];
}

const REPLIES: Record<string, SlackMessage[]> = {
  [ROOT]: [
    { ts: ROOT, user: "U_ALICE", text: "thread root", thread_ts: ROOT, reply_count: 2 },
    { ts: ts(11), bot_id: "B_X", user: "U_BOT", text: "bot reply", thread_ts: ROOT, reactions: [{ name: "eyes", users: ["U_GONE"] }] },
    { ts: ts(12), user: "U_GONE", text: "also sent to channel", thread_ts: ROOT, subtype: "thread_broadcast" },
  ],
};

class FakeSlack {
  calls: string[] = [];
  /** method -> errors to throw on the next calls (FIFO). */
  fail: Record<string, Error[]> = {};
  channels = [CHANNEL, OTHER];
  bookmarks: SlackBookmark[] = [{ id: "Bk1", title: "Wiki", link: "https://wiki.example" }];

  private hit(method: string): void {
    this.calls.push(method);
    const e = this.fail[method]?.shift();
    if (e) throw e;
  }
  private paged<T>(items: T[], cursor: string | null, limit: number): { items: T[]; nextCursor: string | null } {
    const start = cursor ? Number(cursor) : 0;
    const end = start + limit;
    return { items: items.slice(start, end), nextCursor: end < items.length ? String(end) : null };
  }

  client(): SlackClient {
    const api = {
      listChannels: async () => (this.hit("conversations.list"), this.channels),
      usersPage: async (cursor: string | null) => (this.hit("users.list"), this.paged(USERS, cursor, 2)),
      joinChannel: async () => this.hit("conversations.join"),
      membersOfChannel: async () => (this.hit("conversations.members"), ["U_ALICE", "U_GONE", "U_BOT"]),
      bookmarksForChannel: async () => (this.hit("bookmarks.list"), this.bookmarks),
      historyPage: async (_c: string, cursor: string | null, limit = 200) => (this.hit("conversations.history"), this.paged(history(), cursor, limit)),
      repliesPage: async (_c: string, root: string, cursor: string | null, limit = 200) => {
        this.hit("conversations.replies");
        if (!REPLIES[root]) throw new SlackApiError("conversations.replies", "thread_not_found");
        return this.paged(REPLIES[root]!, cursor, limit);
      },
      downloadFile: async (url: string) => {
        this.hit("download");
        return url.endsWith("/404") ? null : new TextEncoder().encode(url).buffer;
      },
    };
    return api as unknown as SlackClient;
  }
}

class FakeBucket {
  puts = new Map<string, string | undefined>();
  async put(key: string, _v: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
    this.puts.set(key, opts?.httpMetadata?.contentType);
    return null;
  }
}

let raw: RawDb;
let slack: FakeSlack;
let bucket: FakeBucket;
let importer: SlackImporter;
let clock: number;
let seq: number;

function build(overrides: Partial<SlackImporterDeps> = {}): SlackImporter {
  return new SlackImporter({
    db,
    slack: slack.client(),
    bucket: bucket as unknown as AttachmentBucket,
    orgId: ORG,
    now: () => new Date(clock).toISOString(),
    newJobId: () => `csij_${seq++}`,
    newLeaseToken: () => `lease_${seq++}`,
    ...overrides,
  });
}

let db: ReturnType<typeof makeImportD1>["d1"];

beforeEach(() => {
  const made = makeImportD1();
  db = made.d1;
  raw = made.raw;
  raw.exec(`INSERT OR IGNORE INTO identity_orgs (id, name, created_at) VALUES ('${ORG}', 'DevHub', '2026-01-01T00:00:00.000Z');`);
  for (const [id, email] of [[ADMIN, "admin@example.com"], [ALICE, "alice@example.com"]]) {
    raw.exec(`INSERT INTO identity_users (id, org_id, email, display_name, status, created_at, updated_at) VALUES ('${id}', '${ORG}', '${email}', '${id}', 'active', 'x', 'x');`);
  }
  slack = new FakeSlack();
  bucket = new FakeBucket();
  clock = Date.parse("2026-10-15T00:00:00.000Z");
  seq = 0;
  importer = build();
});

async function runToEnd(id: string, maxSteps = 100): Promise<{ job: SlackImportJob; steps: number }> {
  for (let steps = 1; steps <= maxSteps; steps++) {
    const job = await importer.step(id);
    if (job.status === "done" || job.status === "failed") return { job, steps };
    clock += job.retryAfterMs;
  }
  throw new Error("import did not finish");
}

const DUB = channelIdFor(CHANNEL);
const msg = (t: string) => messageIdFor("C_GEN", t);
const row = (sql: string, ...args: unknown[]) => raw.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined;

function snapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ["chat_channels", "chat_channel_members", "chat_messages", "chat_reactions", "chat_pins", "chat_read_states", "identity_users", "file_meta_files", "file_meta_links"]) out[t] = count(raw, t);
  return out;
}

describe("SlackImporter — full step loop", () => {
  it("imports channel, history, threads, reactions, pins, bookmarks, files and read markers", async () => {
    const { job: created, created: isNew } = await importer.createJob("#general", ADMIN);
    expect(isNew).toBe(true);
    expect(created).toMatchObject({ status: "queued", phase: "users", slackChannelName: "general", dubChannelId: DUB, isPrivate: false, error: null, retryAfterMs: 0 });

    const { job } = await runToEnd(created.id);
    expect(job.status).toBe("done");
    expect(job.phase).toBe("done");
    expect(job.finishedAt).not.toBeNull();
    expect(job.pending).toEqual({ threads: 0, files: 0 });
    expect(slack.calls).toContain("conversations.join");

    // channel + members: real accounts only (+ the importing admin); creator alice is admin.
    expect(row("SELECT name, visibility, topic, created_by FROM chat_channels WHERE id = ?", DUB)).toEqual({ name: "general", visibility: "public", topic: "雑談", created_by: ALICE });
    const members = raw.prepare("SELECT user_id, role FROM chat_channel_members WHERE channel_id = ? ORDER BY user_id").all(DUB);
    expect(members).toEqual([{ user_id: ADMIN, role: "member" }, { user_id: ALICE, role: "admin" }]);

    // placeholders: disabled, bots suffixed
    const gone = row("SELECT display_name, status FROM identity_users WHERE id = ?", placeholderUserIdFor("U_GONE"));
    expect(gone).toEqual({ display_name: "退職者", status: "disabled" });
    expect(row("SELECT display_name FROM identity_users WHERE id = ?", placeholderUserIdFor("U_BOT"))?.display_name).toBe("Deploy Bot (bot)");
    expect(row("SELECT display_name FROM identity_users WHERE id = ?", placeholderUserIdFor("B_HOOK"))?.display_name).toBe("GitHub (bot)");
    expect(row("SELECT status FROM identity_users WHERE id = ?", placeholderUserIdFor("U_EXT"))?.status).toBe("disabled");

    // mentions -> Dub ids (real and placeholder)
    expect(row("SELECT body FROM chat_messages WHERE id = ?", msg(ts(1)))?.body).toBe(`hello <@${placeholderUserIdFor("U_GONE")}> and <@${placeholderUserIdFor("U_EXT")}>`);

    // ALL reactions, including unmapped reactors and custom emoji
    expect(count(raw, "chat_reactions WHERE message_id = ?", msg(ts(1)))).toBe(4);
    expect(row("SELECT emoji FROM chat_reactions WHERE message_id = ? AND emoji LIKE ':%'", msg(ts(1)))?.emoji).toBe(":partyparrot:");
    expect(count(raw, "chat_reactions WHERE message_id = ?", msg(ts(11)))).toBe(1);

    // threads: reply + broadcast attached to root; orphan broadcast stays top-level;
    // deleted root (thread_not_found) skipped without failing the job.
    expect(row("SELECT thread_root_id FROM chat_messages WHERE id = ?", msg(ts(11)))?.thread_root_id).toBe(msg(ROOT));
    expect(row("SELECT thread_root_id FROM chat_messages WHERE id = ?", msg(ts(12)))?.thread_root_id).toBe(msg(ROOT));
    expect(row("SELECT thread_root_id FROM chat_messages WHERE id = ?", msg(ts(13)))?.thread_root_id).toBeNull();

    // pins: the pinned message + the bookmark system message
    expect(count(raw, "chat_pins WHERE channel_id = ?", DUB)).toBe(2);
    expect(row("SELECT body FROM chat_messages WHERE id = ?", bookmarkMessageIdFor(CHANNEL))?.body).toContain("[Wiki](https://wiki.example)");

    // files: one stored; tombstone + oversize skipped with no rows; 404 rows dropped.
    expect([...bucket.puts.values()]).toEqual(["image/png"]);
    expect(count(raw, "file_meta_files")).toBe(1);
    expect(count(raw, "file_meta_links")).toBe(1);
    expect(JSON.parse(String(row("SELECT attachment_file_ids FROM chat_messages WHERE id = ?", msg(ts(4)))?.attachment_file_ids))).toHaveLength(1);

    // read markers: every member caught up to the newest message
    const newest = row("SELECT MAX(id) AS m FROM chat_messages WHERE channel_id = ?", DUB)?.m;
    expect(raw.prepare("SELECT last_read_message_id AS l FROM chat_read_states WHERE channel_id = ?").all(DUB)).toEqual([{ l: newest }, { l: newest }]);

    // 8 seeded + 55 filler + 1 thread reply (broadcast counted once per pass) + bookmark
    expect(count(raw, "chat_messages WHERE channel_id = ?", DUB)).toBe(65);
    expect(job.counters).toMatchObject({ members: 2, threadReplies: 2, reactions: 5, pins: 1, files: 1, filesSkipped: 3 });
  });

  it("re-running a finished import is idempotent (same rows, job reused)", async () => {
    const { job } = await importer.createJob("general", ADMIN);
    await runToEnd(job.id);
    const before = snapshot();
    const again = await importer.createJob("C_GEN", ADMIN);
    expect(again.created).toBe(false);
    expect(again.job).toMatchObject({ id: job.id, status: "queued", phase: "users" });
    const { job: done } = await runToEnd(job.id);
    expect(done.status).toBe("done");
    expect(snapshot()).toEqual(before);
    expect((await importer.listJobs()).items).toHaveLength(1);
  });

  it("parks on a Slack 429 and resumes after Retry-After", async () => {
    const { job } = await importer.createJob("general", ADMIN);
    slack.fail["conversations.history"] = [new SlackApiError("conversations.history", "rate_limited", 7)];
    let j = job;
    while (j.phase !== "history") j = await importer.step(job.id);
    j = await importer.step(job.id);
    expect(j).toMatchObject({ status: "running", phase: "history", retryAfterMs: 7000, error: null });

    const callsBefore = slack.calls.length;
    j = await importer.step(job.id); // still parked: no Slack call
    expect(slack.calls.length).toBe(callsBefore);
    expect(j.retryAfterMs).toBe(7000);

    clock += 7000;
    const { job: done } = await runToEnd(job.id);
    expect(done.status).toBe("done");
  });

  it("does not step a job whose lease another tab holds", async () => {
    const { job } = await importer.createJob("general", ADMIN);
    const until = new Date(clock + 30_000).toISOString();
    raw.prepare("UPDATE chat_slack_import_jobs SET status = 'running', lease_token = 'other', lease_until = ? WHERE id = ?").run(until, job.id);
    const j = await importer.step(job.id);
    expect(j).toMatchObject({ phase: "users", status: "running" });
    expect(j.retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(slack.calls).not.toContain("users.list");
    expect(row("SELECT lease_token FROM chat_slack_import_jobs WHERE id = ?", job.id)?.lease_token).toBe("other");

    clock += 31_000; // lease expired (tab died): the job is taken over
    const { job: done } = await runToEnd(job.id);
    expect(done.status).toBe("done");
  });

  it("a failed step leaves no rows; re-creating the job resumes from the cursor", async () => {
    const { job } = await importer.createJob("general", ADMIN);
    slack.fail["bookmarks.list"] = [new SlackApiError("bookmarks.list", "missing_scope")];
    const failed = await runToEnd(job.id);
    expect(failed.job).toMatchObject({ status: "failed", phase: "channel", error: { code: "missing_scope" } });
    expect(failed.job.error!.message).toContain("スコープ");
    expect(count(raw, "chat_channels")).toBe(0);

    const resumed = await importer.createJob("general", ADMIN);
    expect(resumed).toMatchObject({ created: false, job: { status: "queued", phase: "channel", error: null } });
    expect((await runToEnd(job.id)).job.status).toBe("done");
  });

  it("without an R2 bucket attachments are skipped with no file rows", async () => {
    importer = build({ bucket: null });
    const { job } = await importer.createJob("general", ADMIN);
    const { job: done } = await runToEnd(job.id);
    expect(done.counters).toMatchObject({ files: 0, filesSkipped: 4 });
    expect(count(raw, "file_meta_files")).toBe(0);
    expect(slack.calls).not.toContain("download");
  });

  it("scopes jobs to the org", async () => {
    const { job } = await importer.createJob("general", ADMIN);
    const other = build({ orgId: "org_other" });
    await expect(other.getJob(job.id)).rejects.toMatchObject({ code: expect.stringMatching(/not_found/i) });
    expect((await other.listJobs()).items).toEqual([]);
    expect((await other.step(job.id).catch((e) => e)).code).toMatch(/not_found/i);
  });
});

describe("Slack import routes", () => {
  const IMPORTER_KEYS: typeof ALL_CHAT_KEYS = [...ALL_CHAT_KEYS, "chat:slack_import"];
  const app = (slackImport?: SlackImporter, keys = IMPORTER_KEYS) =>
    createApp(makeDeps({ slackImport, authz: fakeAuthz(new Set(keys)) }));

  it("answers 412 when SLACK_BOT_TOKEN is not configured", async () => {
    const a = app(build({ slack: null }));
    expect((await call(a, "POST", "/chat/slack-import/jobs", { userId: ADMIN, body: { channel: "general" } })).status).toBe(412);
    expect((await call(a, "GET", "/chat/slack-import/channels", { userId: ADMIN })).status).toBe(412);
    expect((await call(a, "GET", "/chat/slack-import/jobs", { userId: ADMIN })).json).toEqual({ items: [] });
    expect((await call(app(undefined), "GET", "/chat/slack-import/jobs", { userId: ADMIN })).status).toBe(412);
  });

  it("404s an unknown Slack channel and 400s a missing one", async () => {
    const a = app(importer);
    expect((await call(a, "POST", "/chat/slack-import/jobs", { userId: ADMIN, body: { channel: "nope" } })).status).toBe(404);
    expect((await call(a, "POST", "/chat/slack-import/jobs", { userId: ADMIN, body: {} })).status).toBe(400);
  });

  it("creates (201), re-requests (200), steps and lists over HTTP", async () => {
    const a = app(importer);
    const created = await call(a, "POST", "/chat/slack-import/jobs", { userId: ADMIN, body: { channel: "#general" } });
    expect(created.status).toBe(201);
    expect(created.json.createdBy).toBe(ADMIN);
    expect((await call(a, "POST", "/chat/slack-import/jobs", { userId: ADMIN, body: { channel: "general" } })).status).toBe(200);
    const stepped = await call(a, "POST", `/chat/slack-import/jobs/${created.json.id}/step`, { userId: ADMIN });
    expect(stepped.status).toBe(200);
    expect(stepped.json.status).toBe("running");
    expect((await call(a, "GET", `/chat/slack-import/jobs/${created.json.id}`, { userId: ADMIN })).json.id).toBe(created.json.id);
    const picker = await call(a, "GET", "/chat/slack-import/channels", { userId: ADMIN });
    expect(picker.json.items).toEqual([
      { id: "C_GEN", name: "general", isPrivate: false, isArchived: false, memberCount: 4, job: { id: created.json.id, status: "running" } },
      { id: "C_PRIV", name: "secret", isPrivate: true, isArchived: false, memberCount: null, job: null },
    ]);
  });

  it("needs chat:slack_import: 編集 + every other chat key still gets 403", async () => {
    const a = app(importer, ALL_CHAT_KEYS);
    expect((await call(a, "GET", "/chat/slack-import/jobs", { userId: ADMIN })).status).toBe(403);
    expect((await call(a, "POST", "/chat/slack-import/jobs", { userId: ADMIN, body: { channel: "general" } })).status).toBe(403);
  });
});
