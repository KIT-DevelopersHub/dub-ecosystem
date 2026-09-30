// End-to-end dry-run test: fixtures (infra/d1/fixtures/slack) -> runSlackImport ->
// generated SQL applies cleanly to the real aggregated dub-core schema, and a second
// run against the SAME (persisted) ledger imports nothing new — the concrete proof that
// "コード実装＋dry-run可能な状態" actually works end to end without a live Slack token.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { migratedD1 } from "./d1";
import { createLedger } from "../src/slackImport";
import { createFixtureSlackSource } from "../src/slackFixtureSource";
import { runSlackImport, type IdentityUserExportRow } from "../src/slackImportRun";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "slack");
const SYSTEM_USER_ID = "usr_system0000000000000001";

function loadIdentityUsers(): IdentityUserExportRow[] {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "identity-users.json"), "utf8")) as IdentityUserExportRow[];
}

describe("runSlackImport — offline fixture dry-run", () => {
  it("maps both the public and private pilot channels end to end", async () => {
    const source = createFixtureSlackSource(FIXTURE_DIR);
    const ledger = createLedger();
    const result = await runSlackImport({
      source,
      targetChannelIds: ["C_CONF_PUBLIC", "C_CONF_CORE"],
      identityUsers: loadIdentityUsers(),
      systemUserId: SYSTEM_USER_ID,
      ledger,
      nowIso: () => "2026-09-16T00:00:00.000Z",
    });

    expect(result.summary.channels).toBe(2);
    // C_CONF_PUBLIC: 5 top-level (root + Bob + Alice-file + Guest + Bot) + 2 replies
    // pulled in from the thread fixture (not present in the top-level history) = 7.
    // C_CONF_CORE: 1 plain message.
    expect(result.summary.messages).toBe(8);
    expect(result.summary.alreadyImportedMessages).toBe(0);
    // U_GUEST has no identity_users match -> counted, but still imported (embed-name default)
    expect(result.summary.messagesSkippedUnmappedAuthor).toBeGreaterThan(0);
    expect(result.summary.attachments).toBe(1); // reception-guide.pdf
    expect(result.summary.reactions).toBeGreaterThan(0);
    expect(result.summary.reactionsSkippedUnmappedEmoji).toBeGreaterThan(0); // the custom shortcode
    expect(Object.keys(result.channelIds)).toEqual(["C_CONF_PUBLIC", "C_CONF_CORE"]);
    expect(result.pendingUploads).toHaveLength(1);
    expect(result.pendingUploads[0]!.file.name).toBe("reception-guide.pdf");
  });

  it("throws a clear error when a requested channel id is not visible to the bot", async () => {
    const source = createFixtureSlackSource(FIXTURE_DIR);
    await expect(
      runSlackImport({
        source,
        targetChannelIds: ["C_NOT_A_MEMBER"],
        identityUsers: loadIdentityUsers(),
        systemUserId: SYSTEM_USER_ID,
        ledger: createLedger(),
      }),
    ).rejects.toThrow(/C_NOT_A_MEMBER/);
  });

  it("the generated SQL applies cleanly to the real dub-core schema", async () => {
    const { raw } = await migratedD1();
    const source = createFixtureSlackSource(FIXTURE_DIR);
    const result = await runSlackImport({
      source,
      targetChannelIds: ["C_CONF_PUBLIC"],
      identityUsers: loadIdentityUsers(),
      systemUserId: SYSTEM_USER_ID,
      ledger: createLedger(),
      nowIso: () => "2026-09-16T00:00:00.000Z",
    });
    raw.exec(result.sql.join("\n"));

    const channelCount = raw.prepare("SELECT COUNT(*) AS c FROM chat_channels").get() as { c: number };
    expect(Number(channelCount.c)).toBe(1);
    const messageCount = raw.prepare("SELECT COUNT(*) AS c FROM chat_messages").get() as { c: number };
    expect(Number(messageCount.c)).toBe(7);

    // The thread reply landed with thread_root_id pointing at the root's dub id.
    const root = raw.prepare("SELECT id FROM chat_messages WHERE body LIKE ?").get("%今日の進行%") as { id: string };
    const replies = raw.prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE thread_root_id = ?").get(root.id) as { c: number };
    expect(Number(replies.c)).toBe(2);

    // Guest's message kept its content but has no author_id (unmapped, embed-name policy).
    const guestMsg = raw.prepare("SELECT author_id, body FROM chat_messages WHERE body LIKE ?").get("%手伝えることが%") as {
      author_id: string | null;
      body: string;
    };
    expect(guestMsg.author_id).toBeNull();
    expect(guestMsg.body).toContain("[Slack: carol]");
  });

  it("re-running against the SAME persisted ledger is a no-op (idempotent across runs)", async () => {
    const source = createFixtureSlackSource(FIXTURE_DIR);
    const identityUsers = loadIdentityUsers();

    const ledger1 = createLedger();
    const first = await runSlackImport({ source, targetChannelIds: ["C_CONF_PUBLIC"], identityUsers, systemUserId: SYSTEM_USER_ID, ledger: ledger1 });
    expect(first.summary.messages).toBe(7);

    // Persist + reload the ledger exactly like the CLI does between runs.
    const ledger2 = createLedger(ledger1.toJSON());
    const second = await runSlackImport({ source, targetChannelIds: ["C_CONF_PUBLIC"], identityUsers, systemUserId: SYSTEM_USER_ID, ledger: ledger2 });
    expect(second.summary.messages).toBe(0);
    expect(second.summary.alreadyImportedMessages).toBe(7);
    // Only the (idempotent) channel INSERT OR IGNORE remains; no message/reaction/file SQL.
    expect(second.sql).toHaveLength(1);

    // Applying both runs' SQL back to back never duplicates a row.
    const { raw } = await migratedD1();
    raw.exec(first.sql.join("\n"));
    raw.exec(second.sql.join("\n"));
    const messageCount = raw.prepare("SELECT COUNT(*) AS c FROM chat_messages").get() as { c: number };
    expect(Number(messageCount.c)).toBe(7);
  });

  it("includeAttachments: false skips attachment planning entirely", async () => {
    const source = createFixtureSlackSource(FIXTURE_DIR);
    const result = await runSlackImport({
      source,
      targetChannelIds: ["C_CONF_PUBLIC"],
      identityUsers: loadIdentityUsers(),
      systemUserId: SYSTEM_USER_ID,
      ledger: createLedger(),
      includeAttachments: false,
    });
    expect(result.summary.attachments).toBe(0);
    expect(result.pendingUploads).toHaveLength(0);
  });
});
