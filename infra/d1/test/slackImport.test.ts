// Slack -> Dub mapping/SQL-builder unit tests, applied against the real aggregated
// dub-core schema (chat_* + file_meta_* namespaces) exactly like adminNotify.test.ts
// does for notif_notifications — the same migratedD1() harness, the same
// "raw.exec(generated SQL)" apply path a real `wrangler d1 execute --file` run takes.
import { describe, it, expect, beforeEach } from "vitest";
import { migratedD1 } from "./d1";
import {
  DEFAULT_UNMAPPED_POLICY,
  buildChannelRow,
  buildFileLinkRow,
  buildFileMetaRow,
  buildInsertChannelSql,
  buildInsertFileLinkSql,
  buildInsertFileMetaSql,
  buildInsertMessageSql,
  buildInsertReactionSql,
  buildMessageRow,
  buildReactionRows,
  convertSlackBodyToDubBody,
  createLedger,
  mintChannelId,
  mintMessageId,
  resolveEmoji,
  resolveThreadRootId,
  shouldSkipMessage,
  slackTsToMs,
  batchStatements,
  type MappingContext,
  type SlackChannel,
  type SlackImportLedger,
  type SlackMessage,
} from "../src/slackImport";

function ctxFixture(overrides: Partial<MappingContext> = {}): MappingContext {
  return {
    slackUserIdToDubUserId: new Map([
      ["U_ALICE", "usr_alice"],
      ["U_BOB", "usr_bob"],
    ]),
    slackUserIdToDisplayName: new Map([
      ["U_ALICE", "Alice"],
      ["U_BOB", "Bob"],
      ["U_GUEST", "Carol Guest"],
    ]),
    slackChannelIdToName: new Map([["C_GENERAL", "general"]]),
    systemUserId: "usr_system",
    ...overrides,
  };
}

describe("slackTsToMs", () => {
  it("converts a Slack ts to epoch ms, truncating sub-second precision consistently", () => {
    expect(slackTsToMs("1717000000.000100")).toBe(1717000000000);
    expect(slackTsToMs("1717000000.999900")).toBe(1717000001000); // rounds, doesn't truncate
  });
  it("throws on a malformed ts", () => {
    expect(() => slackTsToMs("not-a-ts")).toThrow();
  });
});

describe("convertSlackBodyToDubBody", () => {
  const ctx = ctxFixture();

  it("converts a mapped user mention to dub's <@dubUserId> syntax (same wrapper, new id)", () => {
    expect(convertSlackBodyToDubBody("hi <@U_ALICE>", ctx)).toBe("hi <@usr_alice>");
  });

  it("falls back to a plain-text @name for an unmapped user (never a dangling mention pill)", () => {
    expect(convertSlackBodyToDubBody("hi <@U_GUEST>", ctx)).toBe("hi @Carol Guest");
  });

  it("converts a labelled user mention (label discarded, id still substituted)", () => {
    expect(convertSlackBodyToDubBody("<@U_BOB|bob>", ctx)).toBe("<@usr_bob>");
  });

  it("converts a channel reference to plain #name", () => {
    expect(convertSlackBodyToDubBody("see <#C_GENERAL|general>", ctx)).toBe("see #general");
    expect(convertSlackBodyToDubBody("see <#C_GENERAL>", ctx)).toBe("see #general"); // falls back to the name map
  });

  it("converts special mentions to plain @text", () => {
    expect(convertSlackBodyToDubBody("<!channel> please read", ctx)).toBe("@channel please read");
    expect(convertSlackBodyToDubBody("<!here>", ctx)).toBe("@here");
  });

  it("converts a Slack link to dub's [label](url) markdown syntax", () => {
    expect(convertSlackBodyToDubBody("<https://example.com|Example>", ctx)).toBe("[Example](https://example.com)");
    expect(convertSlackBodyToDubBody("<https://example.com>", ctx)).toBe("[https://example.com](https://example.com)");
  });

  it("decodes Slack's HTML-entity-escaped literal text", () => {
    expect(convertSlackBodyToDubBody("A &amp; B &lt;tag&gt;", ctx)).toBe("A & B <tag>");
  });

  it("leaves shared-syntax formatting (*bold* _italic_ ~strike~ `code`) untouched", () => {
    const body = "*bold* _italic_ ~strike~ `code` normal";
    expect(convertSlackBodyToDubBody(body, ctx)).toBe(body);
  });

  it("is total — never throws on a body with no special tokens", () => {
    expect(convertSlackBodyToDubBody("plain text, no tokens", ctx)).toBe("plain text, no tokens");
  });
});

describe("resolveEmoji", () => {
  it("maps common Slack shortcodes to a unicode glyph", () => {
    expect(resolveEmoji("thumbsup")).toBe("👍");
    expect(resolveEmoji("+1")).toBe("👍");
    expect(resolveEmoji("tada")).toBe("🎉");
  });
  it("returns null for an unmapped shortcode (never a bare ':shortcode:' string)", () => {
    expect(resolveEmoji("some_custom_emoji_not_in_map")).toBeNull();
  });
});

describe("ledger — idempotency", () => {
  let ledger: SlackImportLedger;
  beforeEach(() => {
    ledger = createLedger();
  });

  it("mints a message id once per (channel, ts); a second call reuses it (isNew=false)", () => {
    const first = mintMessageId(ledger, "C1", "1717000000.000100");
    expect(first.isNew).toBe(true);
    const second = mintMessageId(ledger, "C1", "1717000000.000100");
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("the same ts in two different channels mints two distinct ids", () => {
    const a = mintMessageId(ledger, "C1", "1717000000.000100");
    const b = mintMessageId(ledger, "C2", "1717000000.000100");
    expect(a.id).not.toBe(b.id);
  });

  it("the minted id's time component reflects the Slack ts (chronological id ordering)", () => {
    const early = mintMessageId(ledger, "C1", "1717000000.000100").id;
    const late = mintMessageId(ledger, "C1", "1717000100.000100").id;
    // ULID time component is lexicographically ordered — later Slack ts -> greater id.
    expect(late > early).toBe(true);
  });

  it("channel ids are minted once per Slack channel id and persist across seeded reloads", () => {
    const a = mintChannelId(ledger, "C1");
    const restored = createLedger(ledger.toJSON());
    const b = mintChannelId(restored, "C1");
    expect(b.id).toBe(a.id);
    expect(b.isNew).toBe(false);
  });
});

describe("buildMessageRow — unmapped-author handling", () => {
  const ctx = ctxFixture();

  it("embed-name policy (default): keeps kind='user', author_id=null, prefixes the body with the Slack name", () => {
    const ledger = createLedger();
    const msg: SlackMessage = { ts: "1717000000.000100", user: "U_GUEST", text: "hello" };
    const row = buildMessageRow({ slack: msg, dubChannelId: "chan_x", slackChannelId: "C1", ledger, ctx });
    expect(row.authorId).toBeNull();
    expect(row.body).toBe("[Slack: Carol Guest] hello");
    expect(shouldSkipMessage(msg, ctx)).toBe(false);
  });

  it("skip-message policy: shouldSkipMessage is true for an unmapped author", () => {
    const skipCtx = ctxFixture({ unmappedUserPolicy: "skip-message" });
    const msg: SlackMessage = { ts: "1717000000.000100", user: "U_GUEST", text: "hello" };
    expect(shouldSkipMessage(msg, skipCtx)).toBe(true);
  });

  it("a mapped author is never skipped and the body is not prefixed", () => {
    const msg: SlackMessage = { ts: "1717000000.000100", user: "U_ALICE", text: "hello" };
    const row = buildMessageRow({ slack: msg, dubChannelId: "chan_x", slackChannelId: "C1", ledger: createLedger(), ctx });
    expect(row.authorId).toBe("usr_alice");
    expect(row.body).toBe("hello");
  });

  it("a message with no user at all (bot/system) is never skipped and has no author", () => {
    const msg: SlackMessage = { ts: "1717000000.000100", text: "reminder", subtype: "bot_message" };
    expect(shouldSkipMessage(msg, ctx)).toBe(false);
    const row = buildMessageRow({ slack: msg, dubChannelId: "chan_x", slackChannelId: "C1", ledger: createLedger(), ctx });
    expect(row.authorId).toBeNull();
    expect(row.body).toBe("reminder");
  });

  it("the default policy constant is 'embed-name'", () => {
    expect(DEFAULT_UNMAPPED_POLICY).toBe("embed-name");
  });
});

describe("resolveThreadRootId", () => {
  it("a top-level message (no thread_ts) has no root", () => {
    const ledger = createLedger();
    expect(resolveThreadRootId({ ts: "1", text: "" }, "C1", ledger)).toBeNull();
  });
  it("a thread ROOT (thread_ts === ts) has no root of its own", () => {
    const ledger = createLedger();
    expect(resolveThreadRootId({ ts: "1", thread_ts: "1", text: "" }, "C1", ledger)).toBeNull();
  });
  it("a reply resolves to the root's minted id", () => {
    const ledger = createLedger();
    const { id: rootId } = mintMessageId(ledger, "C1", "1");
    expect(resolveThreadRootId({ ts: "2", thread_ts: "1", text: "" }, "C1", ledger)).toBe(rootId);
  });
  it("a reply whose root was never minted (outside fetch window) resolves to null, not a crash", () => {
    const ledger = createLedger();
    expect(resolveThreadRootId({ ts: "2", thread_ts: "999", text: "" }, "C1", ledger)).toBeNull();
  });
});

describe("buildReactionRows", () => {
  const ctx = ctxFixture();
  it("drops reactions from unmapped users and unmapped shortcodes, keeps the rest", () => {
    const msg: SlackMessage = {
      ts: "1",
      text: "",
      reactions: [
        { name: "thumbsup", users: ["U_ALICE", "U_GUEST"] }, // 1 kept, 1 dropped (unmapped user)
        { name: "not_a_real_emoji", users: ["U_BOB"] }, // dropped (unmapped emoji)
      ],
    };
    const result = buildReactionRows(msg, "msg_x", "2026-01-01T00:00:00.000Z", ctx);
    expect(result.rows).toEqual([{ messageId: "msg_x", emoji: "👍", userId: "usr_alice", createdAt: "2026-01-01T00:00:00.000Z" }]);
    expect(result.skippedUnmappedUser).toBe(1);
    expect(result.skippedUnmappedEmoji).toBe(1);
  });
});

describe("batchStatements", () => {
  it("splits into chunks of at most maxPerBatch", () => {
    const stmts = Array.from({ length: 450 }, (_, i) => `S${i}`);
    const batches = batchStatements(stmts, 200);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(200);
    expect(batches[2]).toHaveLength(50);
  });
  it("returns [] for an empty input", () => {
    expect(batchStatements([])).toEqual([]);
  });
});

describe("end-to-end SQL application against the real dub-core schema", () => {
  const slackChannel: SlackChannel = {
    id: "C1",
    name: "conference-general",
    is_private: false,
    topic: { value: "全体連絡" },
    creator: "U_ALICE",
  };

  it("channel -> message -> reaction -> file_meta insert chain applies cleanly and round-trips", async () => {
    const { raw } = await migratedD1();
    const ledger = createLedger();
    const ctx = ctxFixture();

    const channelRow = buildChannelRow(slackChannel, ledger, ctx, "2026-01-01T00:00:00.000Z");
    raw.exec(buildInsertChannelSql(channelRow));

    const msg: SlackMessage = {
      ts: "1717000000.000100",
      user: "U_ALICE",
      text: "受付資料です <@U_BOB>",
      reactions: [{ name: "tada", users: ["U_BOB"] }],
      files: [{ id: "F1", name: "guide.pdf", mimetype: "application/pdf", size: 1024 }],
    };
    const fileRow = buildFileMetaRow(msg.files![0]!, "C1", msg.ts, "usr_alice", ledger, "2026-01-01T00:00:00.000Z");
    raw.exec(buildInsertFileMetaSql(fileRow));

    const messageRow = buildMessageRow({
      slack: msg,
      dubChannelId: channelRow.id,
      slackChannelId: "C1",
      ledger,
      ctx,
      attachmentFileIds: [fileRow.id],
      threadRootId: resolveThreadRootId(msg, "C1", ledger),
    });
    raw.exec(buildInsertMessageSql(messageRow));
    raw.exec(buildInsertFileLinkSql(buildFileLinkRow(fileRow.id, messageRow.id, "usr_alice", "2026-01-01T00:00:00.000Z")));

    for (const r of buildReactionRows(msg, messageRow.id, messageRow.createdAt, ctx).rows) {
      raw.exec(buildInsertReactionSql(r));
    }

    const channelInDb = raw.prepare("SELECT * FROM chat_channels WHERE id = ?").get(channelRow.id) as Record<string, unknown>;
    expect(channelInDb.visibility).toBe("public");
    expect(channelInDb.name).toBe("conference-general");

    const messageInDb = raw.prepare("SELECT * FROM chat_messages WHERE id = ?").get(messageRow.id) as Record<string, unknown>;
    expect(messageInDb.channel_id).toBe(channelRow.id);
    expect(messageInDb.author_id).toBe("usr_alice");
    expect(messageInDb.body).toBe("受付資料です <@usr_bob>");
    expect(JSON.parse(String(messageInDb.attachment_file_ids))).toEqual([fileRow.id]);

    const reactionInDb = raw.prepare("SELECT * FROM chat_reactions WHERE message_id = ?").get(messageRow.id) as Record<string, unknown>;
    expect(reactionInDb.emoji).toBe("🎉");
    expect(reactionInDb.user_id).toBe("usr_bob");

    const fileInDb = raw.prepare("SELECT * FROM file_meta_files WHERE id = ?").get(fileRow.id) as Record<string, unknown>;
    expect(fileInDb.r2_key).toBe(fileRow.r2Key);
    const linkInDb = raw.prepare("SELECT * FROM file_meta_links WHERE file_id = ?").get(fileRow.id) as Record<string, unknown>;
    expect(linkInDb.target_type).toBe("message");
    expect(linkInDb.target_id).toBe(messageRow.id);
  });

  it("re-applying the exact same generated SQL twice is idempotent (INSERT OR IGNORE)", async () => {
    const { raw } = await migratedD1();
    const ledger = createLedger();
    const ctx = ctxFixture();
    const channelRow = buildChannelRow(slackChannel, ledger, ctx, "2026-01-01T00:00:00.000Z");
    const sql = buildInsertChannelSql(channelRow);
    raw.exec(sql);
    raw.exec(sql);
    const count = raw.prepare("SELECT COUNT(*) AS c FROM chat_channels").get() as { c: number };
    expect(Number(count.c)).toBe(1);
  });

  it("thread reply resolves thread_root_id to the root message's dub id", async () => {
    const { raw } = await migratedD1();
    const ledger = createLedger();
    const ctx = ctxFixture();
    const channelRow = buildChannelRow(slackChannel, ledger, ctx, "2026-01-01T00:00:00.000Z");
    raw.exec(buildInsertChannelSql(channelRow));

    const root: SlackMessage = { ts: "1717000000.000100", user: "U_ALICE", text: "root", thread_ts: "1717000000.000100", reply_count: 1 };
    const reply: SlackMessage = { ts: "1717000010.000100", user: "U_BOB", text: "reply", thread_ts: "1717000000.000100" };

    // 2-pass: mint every message's id before building any row (mirrors slackImportRun.ts).
    mintMessageId(ledger, "C1", root.ts);
    mintMessageId(ledger, "C1", reply.ts);

    const rootRow = buildMessageRow({
      slack: root,
      dubChannelId: channelRow.id,
      slackChannelId: "C1",
      ledger,
      ctx,
      threadRootId: resolveThreadRootId(root, "C1", ledger),
    });
    const replyRow = buildMessageRow({
      slack: reply,
      dubChannelId: channelRow.id,
      slackChannelId: "C1",
      ledger,
      ctx,
      threadRootId: resolveThreadRootId(reply, "C1", ledger),
    });
    raw.exec(buildInsertMessageSql(rootRow));
    raw.exec(buildInsertMessageSql(replyRow));

    expect(rootRow.threadRootId).toBeNull();
    expect(replyRow.threadRootId).toBe(rootRow.id);

    const replyInDb = raw.prepare("SELECT thread_root_id FROM chat_messages WHERE id = ?").get(replyRow.id) as { thread_root_id: string };
    expect(replyInDb.thread_root_id).toBe(rootRow.id);
  });
});
