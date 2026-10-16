// Pure mapping layer of the Slack history importer (packages/slack-import/src/mapping.ts).
import { describe, it, expect } from "vitest";
import {
  type MappingContext,
  type SlackMessage,
  batchStatements,
  buildInsertPinSql,
  buildInsertReactionSql,
  compactStatements,
  bookmarkMessageIdFor,
  buildBookmarkBody,
  buildMessageRow,
  buildReactionRows,
  channelIdFor,
  convertSlackBodyToDubBody,
  isDownloadable,
  messageIdFor,
  placeholderDisplayName,
  placeholderEmailFor,
  placeholderUserIdFor,
  resolveEmoji,
  slackTsToMs,
} from "../src/mapping";

const ctx: MappingContext = {
  slackUserIdToDubUserId: new Map([
    ["U_ALICE", "usr_alice"],
    ["U_GONE", "usr_placeholder_gone"],
  ]),
  slackUserIdToDisplayName: new Map([
    ["U_ALICE", "alice"],
    ["U_GONE", "gone"],
    ["U_OTHER", "other"],
  ]),
  slackChannelIdToName: new Map([["C_GEN", "general"]]),
  systemUserId: "usr_system",
};

describe("deterministic ids", () => {
  it("the same Slack message always maps to the same dub id", () => {
    expect(messageIdFor("C1", "1717000000.000100")).toBe(messageIdFor("C1", "1717000000.000100"));
    expect(messageIdFor("C1", "1717000000.000100")).not.toBe(messageIdFor("C2", "1717000000.000100"));
  });

  it("ids sort chronologically by Slack ts and keep the newId shape", () => {
    const a = messageIdFor("C1", "1717000000.000100");
    const b = messageIdFor("C1", "1717000001.000000");
    expect(a < b).toBe(true);
    expect(a).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("channel / placeholder ids are stable per Slack id", () => {
    expect(channelIdFor({ id: "C1", name: "x", created: 1 })).toBe(channelIdFor({ id: "C1", name: "renamed", created: 1 }));
    expect(placeholderUserIdFor("U1")).toBe(placeholderUserIdFor("U1"));
    expect(placeholderUserIdFor("U1")).not.toBe(placeholderUserIdFor("U2"));
  });

  it("slackTsToMs parses sub-second precision and rejects garbage", () => {
    expect(slackTsToMs("1717000000.500000")).toBe(1717000000500);
    expect(() => slackTsToMs("nope")).toThrow();
  });
});

describe("placeholder users", () => {
  it("bots get a (bot) suffix; people keep their name", () => {
    expect(placeholderDisplayName("Reminder", true)).toBe("Reminder (bot)");
    expect(placeholderDisplayName("carol", false)).toBe("carol");
  });

  it("email is deterministic and undeliverable", () => {
    expect(placeholderEmailFor("U_GUEST")).toBe("slack-u_guest@slack-import.invalid");
  });
});

describe("convertSlackBodyToDubBody", () => {
  it("mentions: mapped -> <@id>, unmapped -> @name", () => {
    expect(convertSlackBodyToDubBody("hi <@U_ALICE> <@U_GONE> <@U_OTHER>", ctx)).toBe("hi <@usr_alice> <@usr_placeholder_gone> @other");
  });

  it("channels, specials, links, entities", () => {
    expect(convertSlackBodyToDubBody("<#C_GEN> <#C_X|random>", ctx)).toBe("#general #random");
    expect(convertSlackBodyToDubBody("<!here> <!subteam^S1|@ops>", ctx)).toBe("@here @ops");
    expect(convertSlackBodyToDubBody("<https://x.com|site> <mailto:a@b.c|mail>", ctx)).toBe("[site](https://x.com) [mail](mailto:a@b.c)");
    expect(convertSlackBodyToDubBody("a &amp;lt; b &lt; c", ctx)).toBe("a &lt; b < c");
  });

  it("keeps shared formatting untouched", () => {
    expect(convertSlackBodyToDubBody("*b* _i_ ~s~ `c`", ctx)).toBe("*b* _i_ ~s~ `c`");
  });

  it("re-lays Slack inline ``` fences onto their own lines so the code text survives", () => {
    expect(convertSlackBodyToDubBody("```npm i\nfoo```", ctx)).toBe("```\nnpm i\nfoo\n```");
    expect(convertSlackBodyToDubBody("```hello```", ctx)).toBe("```\nhello\n```");
    expect(convertSlackBodyToDubBody("see ```x``` here", ctx)).toBe("see \n```\nx\n```\n here");
    expect(convertSlackBodyToDubBody("run:\n```\na &lt; b\n```\ndone", ctx)).toBe("run:\n```\na < b\n```\ndone");
  });

  it("shows links inside code as text and keeps an unclosed ``` literal", () => {
    expect(convertSlackBodyToDubBody("```curl <https://x.com>```", ctx)).toBe("```\ncurl https://x.com\n```");
    expect(convertSlackBodyToDubBody("a ``` b", ctx)).toBe("a ``` b");
  });
});

describe("resolveEmoji", () => {
  it("maps standard shortcodes, applies skin tones, keeps custom emoji as :name:", () => {
    expect(resolveEmoji("thumbsup")).toBe("👍");
    expect(resolveEmoji("+1::skin-tone-2")).toBe("👍🏻");
    expect(resolveEmoji("party_parrot")).toBe(":party_parrot:");
  });
});

describe("buildMessageRow", () => {
  const base: SlackMessage = { ts: "1717000000.000100", user: "U_ALICE", text: "hello" };

  it("maps author, thread root, edited time", () => {
    const reply = buildMessageRow({
      slack: { ...base, ts: "1717000010.000000", thread_ts: base.ts, edited: { ts: "1717000020.000000" } },
      slackChannelId: "C1",
      dubChannelId: "chan_1",
      ctx,
    });
    expect(reply.authorId).toBe("usr_alice");
    expect(reply.threadRootId).toBe(messageIdFor("C1", base.ts));
    expect(reply.editedAt).toBe(new Date(1717000020000).toISOString());
    expect(buildMessageRow({ slack: base, slackChannelId: "C1", dubChannelId: "chan_1", ctx }).threadRootId).toBeNull();
  });

  it("bot posts without text keep their legacy attachment content", () => {
    const row = buildMessageRow({
      slack: { ts: "1717000000.000100", bot_id: "B1", text: "", attachments: [{ title: "Reminder", text: "13:00 start" }] },
      slackChannelId: "C1",
      dubChannelId: "chan_1",
      ctx,
    });
    expect(row.body).toBe("> *Reminder*\n> 13:00 start");
  });

  it("join/leave become system lines", () => {
    const row = buildMessageRow({ slack: { ...base, subtype: "channel_join" }, slackChannelId: "C1", dubChannelId: "chan_1", ctx });
    expect(row.kind).toBe("system");
    expect(row.authorId).toBeNull();
    expect(row.body).toBe("alice がチャンネルに参加しました");
  });
});

describe("buildReactionRows", () => {
  it("keeps every reaction, including custom emoji", () => {
    const rows = buildReactionRows(
      { ts: "1", text: "", reactions: [{ name: "tada", users: ["U_ALICE", "U_GONE"] }, { name: "parrot", users: ["U_ALICE"] }] },
      "msg_1",
      "2024-01-01T00:00:00.000Z",
      ctx,
    );
    expect(rows.map((r) => `${r.emoji}|${r.userId}`)).toEqual(["🎉|usr_alice", "🎉|usr_placeholder_gone", ":parrot:|usr_alice"]);
  });
});

describe("bookmarks", () => {
  it("lists link bookmarks only, with emoji", () => {
    expect(
      buildBookmarkBody([
        { id: "1", title: "Manual", link: "https://m", emoji: ":book:" },
        { id: "2", title: "folder", type: "folder" },
      ]),
    ).toBe("*Slack のブックマーク*\n- 📖 [Manual](https://m)");
    expect(buildBookmarkBody([])).toBeNull();
  });

  it("bookmark message id is stable per channel", () => {
    expect(bookmarkMessageIdFor({ id: "C1", name: "a", created: 1 })).toBe(bookmarkMessageIdFor({ id: "C1", name: "b", created: 1 }));
  });
});

describe("misc", () => {
  it("free-plan hidden / deleted files are not downloadable", () => {
    expect(isDownloadable({ id: "F", url_private: "https://f" })).toBe(true);
    expect(isDownloadable({ id: "F", url_private: "https://f", mode: "hidden_by_limit" })).toBe(false);
    expect(isDownloadable({ id: "F", mode: "tombstone" })).toBe(false);
  });

  it("batchStatements splits into chunks", () => {
    expect(batchStatements(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(batchStatements([], 2)).toEqual([]);
  });

  it("compactStatements merges per table in first-occurrence order and caps by UTF-8 bytes", () => {
    const r = (id: string, emoji: string) => buildInsertReactionSql({ messageId: id, emoji, userId: "u", createdAt: "t" });
    const out = compactStatements([r("m1", "a"), buildInsertPinSql("c", "m1", "u", "t"), r("m2", "b"), "DELETE FROM x;"]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^INSERT OR IGNORE INTO chat_reactions[\s\S]*'m1'[\s\S]*'m2'[\s\S]*;$/);
    expect(out[1]).toContain("chat_pins");
    expect(out[2]).toBe("DELETE FROM x;");
    // 3-byte chars: 40 tuples of ~3KB UTF-8 (1K UTF-16 units) must split under a 10KB cap.
    const big = Array.from({ length: 40 }, (_, i) => r(`m${i}`, "あ".repeat(1000)));
    const chunks = compactStatements(big, { maxBytes: 10_000 });
    expect(chunks.length).toBeGreaterThanOrEqual(12);
    for (const c of chunks) expect(new TextEncoder().encode(c).length).toBeLessThan(10_000 + 500);
  });
});
