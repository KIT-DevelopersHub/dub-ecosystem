// End-to-end dry-run: fixtures (infra/d1/fixtures/slack) -> runSlackImport -> the
// generated SQL applied to the real aggregated dub-core schema, twice (idempotency).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { count, fkViolations, migratedD1 } from "./d1";
import { createFixtureSlackSource } from "../src/slackFixtureSource";
import { placeholderUserIdFor, runSlackImport, type IdentityUserExportRow, type SlackImportConfig } from "@dub/slack-import";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "slack");
const ORG_ID = "org_fixture";
const SYSTEM_USER_ID = "usr_system0000000000000001";

const identityUsers = JSON.parse(readFileSync(join(FIXTURE_DIR, "identity-users.json"), "utf8")) as IdentityUserExportRow[];

function config(overrides: Partial<SlackImportConfig> = {}): SlackImportConfig {
  return {
    source: createFixtureSlackSource(FIXTURE_DIR),
    targetChannels: ["conference-general", "C_CONF_CORE"],
    identityUsers,
    orgId: ORG_ID,
    systemUserId: SYSTEM_USER_ID,
    nowIso: () => "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

async function seededDb() {
  const { raw } = await migratedD1();
  const t = "2026-01-01T00:00:00.000Z";
  raw.exec(`INSERT INTO identity_orgs (id, name, created_at) VALUES ('${ORG_ID}', 'DevHub', '${t}');`);
  for (const u of [...identityUsers, { id: SYSTEM_USER_ID, email: "ops@developershub.jp" }]) {
    raw.exec(
      `INSERT INTO identity_users (id, org_id, email, display_name, created_at, updated_at) VALUES ('${u.id}', '${ORG_ID}', '${u.email}', '${u.id}', '${t}', '${t}');`,
    );
  }
  return raw;
}

describe("runSlackImport — offline fixture dry-run", () => {
  it("summarises everything the fixtures contain", async () => {
    const { summary, pendingUploads, channelIds } = await runSlackImport(config());
    expect(summary.channels).toBe(2);
    // public: 8 history + 2 thread replies, private: 1
    expect(summary.messages).toBe(11);
    expect(summary.threadReplies).toBe(2); // the orphan reply is surfaced top-level
    // U_GUEST, U_BOT (Slack bot user), B_REMINDER (bot_id-only post)
    expect(summary.placeholderUsers).toBe(3);
    expect(summary.reactions).toBe(5);
    expect(summary.customEmojiReactions).toBe(1);
    expect(summary.pins).toBe(1);
    expect(summary.bookmarks).toBe(2);
    expect(summary.attachments).toBe(1);
    expect(summary.attachmentsUnavailable).toBe(1);
    expect(summary.members).toBe(3); // public: alice+bob (guest has no account), private: bob
    expect(pendingUploads.map((u) => u.file.name)).toEqual(["reception-guide.pdf"]);
    expect(Object.keys(channelIds)).toEqual(["C_CONF_PUBLIC", "C_CONF_CORE"]);
  });

  it("names a channel the token cannot see", async () => {
    await expect(runSlackImport(config({ targetChannels: ["#not-invited"] }))).rejects.toThrow(/not-invited/);
  });

  it("applies cleanly to the real schema and re-applying is a no-op", async () => {
    const raw = await seededDb();
    const first = await runSlackImport(config());
    raw.exec(first.sql.join("\n"));
    const second = await runSlackImport(config({ nowIso: () => "2026-10-16T00:00:00.000Z" }));
    raw.exec(second.sql.join("\n"));

    expect(fkViolations(raw)).toEqual([]);
    expect(count(raw, "chat_channels")).toBe(2);
    expect(count(raw, "chat_messages")).toBe(12); // 11 + the pinned bookmarks message
    expect(count(raw, "chat_reactions")).toBe(5);
    expect(count(raw, "chat_pins")).toBe(2);
    expect(count(raw, "file_meta_files")).toBe(1);

    const channel = raw.prepare("SELECT visibility FROM chat_channels WHERE name = 'conference-core-private'").get() as { visibility: string };
    expect(channel.visibility).toBe("private");

    const guest = raw.prepare("SELECT display_name, status FROM identity_users WHERE id = ?").get(placeholderUserIdFor("U_GUEST")) as {
      display_name: string;
      status: string;
    };
    expect({ ...guest }).toEqual({ display_name: "carol", status: "disabled" });
    const bot = raw.prepare("SELECT display_name FROM identity_users WHERE id = ?").get(placeholderUserIdFor("B_REMINDER")) as { display_name: string };
    expect(bot.display_name).toBe("Reminder (bot)");

    const guestMsg = raw.prepare("SELECT author_id FROM chat_messages WHERE body LIKE ?").get("%手伝えることが%") as { author_id: string };
    expect(guestMsg.author_id).toBe(placeholderUserIdFor("U_GUEST"));

    const root = raw.prepare("SELECT id FROM chat_messages WHERE body LIKE ?").get("%今日の進行%") as { id: string };
    expect(Number((raw.prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE thread_root_id = ?").get(root.id) as { c: number }).c)).toBe(2);

    const orphan = raw.prepare("SELECT thread_root_id FROM chat_messages WHERE body LIKE ?").get("%古いスレッド%") as { thread_root_id: string | null };
    expect(orphan.thread_root_id).toBeNull();
  });
});
