#!/usr/bin/env -S node --import tsx
// Slack history -> Dub fe6-chat (D1) importer — CLI entrypoint (方式A: Slack Web API).
//
// PREVIEW-FIRST (default, mirrors admin-notify-backfill.ts): fetches/parses/maps and
// writes the generated idempotent .sql to --out, but touches neither remote D1 nor R2.
// Real writes require BOTH --apply AND CLOUDFLARE_API_TOKEN (+ SLACK_BOT_TOKEN for a
// live, non-fixture run) — run only with the owner's explicit go-ahead.
// Re-running is always safe: every dub id is derived from the Slack id (@dub/slack-import).
//
// Two run modes:
//   --fixture-dir <dir>   Offline dry-run. Reads Slack-API-shaped JSON fixtures instead
//                          of the network (see infra/d1/fixtures/slack/README.md).
//                          --apply is refused in this mode — it can never touch prod.
//   --channels <list>     Live mode. Comma-separated Slack channel names or ids. Requires
//                          SLACK_BOT_TOKEN and fetches from the Slack Web API (@dub/slack-import client).
//
// Usage:
//   # offline dry-run against the checked-in fixtures (no token needed)
//   node --import tsx infra/d1/scripts/slack-import.ts \
//     --fixture-dir infra/d1/fixtures/slack \
//     --identity-export infra/d1/fixtures/slack/identity-users.json \
//     --org-id org_fixture --system-user-id usr_system0000000000000001
//
//   # live preview (needs SLACK_BOT_TOKEN; writes nothing to D1/R2)
//   SLACK_BOT_TOKEN=xoxb-... CLOUDFLARE_API_TOKEN=... node --import tsx infra/d1/scripts/slack-import.ts \
//     --channels general,random --system-user-id usr_...
//
//   # apply (writes to remote dub-core D1 + uploads attachments to R2)
//   ... same as above ... --apply
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  batchStatements,
  createSlackClient,
  R2_ATTACHMENT_BUCKET,
  resolveTargetChannels,
  runSlackImport,
  type IdentityUserExportRow,
  type SlackSource,
} from "@dub/slack-import";
import { createFixtureSlackSource } from "../src/slackFixtureSource";

const WRANGLER = ["dlx", "wrangler@4.35.0"]; // matches infra/d1/scripts/admin-notify.ts
const D1_NAME = "dub-core";
const DEFAULT_BATCH_SIZE = 200;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

type IdentityRow = IdentityUserExportRow & { org_id?: string };

/** CURRENT remote identity_users via wrangler (needs CLOUDFLARE_API_TOKEN). */
function readRemoteIdentityUsers(): IdentityRow[] {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.error("slack-import: CLOUDFLARE_API_TOKEN is required to read identity_users (or pass --identity-export).");
    process.exit(2);
  }
  const out = execFileSync(
    "pnpm",
    [...WRANGLER, "d1", "execute", D1_NAME, "--remote", "--json", "--command", "SELECT id, email, org_id FROM identity_users"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as Array<{ results?: IdentityRow[] }>;
  return parsed.flatMap((block) => block.results ?? []);
}

function writeSqlBatches(sql: string[], outDir: string, batchSize: number): string[] {
  mkdirSync(outDir, { recursive: true });
  return batchStatements(sql, batchSize).map((batch, i) => {
    const file = join(outDir, `batch-${String(i + 1).padStart(3, "0")}.sql`);
    writeFileSync(file, batch.join("\n") + "\n", "utf8");
    return file;
  });
}

async function main(): Promise<void> {
  const fixtureDir = flag("fixture-dir");
  const channelsArg = flag("channels");
  const apply = has("apply");
  const systemUserId = flag("system-user-id");
  const outDir = flag("out") ?? mkdtempSync(join(tmpdir(), "slack-import-"));
  const batchSize = Number(flag("batch-size") ?? DEFAULT_BATCH_SIZE);
  const includeAttachments = !has("no-attachments");

  if (!systemUserId) {
    console.error("slack-import: --system-user-id is required (operator account; created_by fallback).");
    process.exit(2);
  }
  if (apply && fixtureDir) {
    console.error("slack-import: --apply is refused together with --fixture-dir (fixtures are dry-run only).");
    process.exit(2);
  }

  let source: SlackSource;
  let targetChannels: string[];
  let client: ReturnType<typeof createSlackClient> | undefined;

  if (fixtureDir) {
    source = createFixtureSlackSource(fixtureDir);
    targetChannels = channelsArg ? channelsArg.split(",") : (await source.listChannels()).map((c) => c.id);
  } else {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token || !channelsArg) {
      console.error("slack-import: a live run needs SLACK_BOT_TOKEN and --channels <name1,name2,...> (or use --fixture-dir).");
      process.exit(2);
    }
    client = createSlackClient({ token });
    targetChannels = channelsArg.split(",");
    // Public channels: the bot joins by itself (channels:join). Private: must be invited.
    const listed = await client.listChannels();
    for (const c of resolveTargetChannels(listed, targetChannels)) {
      if (!c.is_private && !c.is_member) {
        console.log(`slack-import: joining #${c.name}...`);
        await client.joinChannel(c.id);
      }
    }
    source = client;
  }

  const identityUsers: IdentityRow[] = flag("identity-export")
    ? (JSON.parse(readFileSync(flag("identity-export")!, "utf8")) as IdentityRow[])
    : fixtureDir
      ? []
      : readRemoteIdentityUsers();
  const orgId = flag("org-id") ?? identityUsers.find((u) => u.org_id)?.org_id;
  if (!orgId) {
    console.error("slack-import: could not determine identity org id; pass --org-id.");
    process.exit(2);
  }

  const result = await runSlackImport({ source, targetChannels, identityUsers, orgId, systemUserId, includeAttachments });

  const s = result.summary;
  console.log(`# slack-import ${fixtureDir ? "DRY-RUN (fixtures)" : apply ? "APPLY" : "PREVIEW"}`);
  console.log(`# channels: ${s.channels}  members: ${s.members}  placeholder users (disabled): ${s.placeholderUsers}`);
  console.log(`# messages: ${s.messages} (thread replies: ${s.threadReplies})  pins: ${s.pins}  bookmarks: ${s.bookmarks}`);
  console.log(`# reactions: ${s.reactions} (custom emoji kept as :name:: ${s.customEmojiReactions})`);
  console.log(`# attachments: ${s.attachments} (unavailable on Slack side: ${s.attachmentsUnavailable})`);
  console.log(`# total SQL statements: ${s.estimatedStatements}  (batches of ${batchSize}: ${Math.ceil(s.estimatedStatements / batchSize)})`);
  console.log(`# channel id map: ${JSON.stringify(result.channelIds)}`);

  const files = writeSqlBatches(result.sql, outDir, batchSize);
  console.log(`# wrote ${files.length} SQL batch file(s) to ${outDir}`);

  if (!apply) {
    console.log("\n# PREVIEW — nothing written to remote D1/R2. Re-run with --apply (+ CLOUDFLARE_API_TOKEN) to write.");
    return;
  }
  if (!process.env.CLOUDFLARE_API_TOKEN || !client) {
    console.error("slack-import --apply: CLOUDFLARE_API_TOKEN and a live Slack token are required.");
    process.exit(2);
  }

  for (const file of files) {
    console.log(`slack-import: applying ${file} to remote ${D1_NAME}...`);
    execFileSync("pnpm", [...WRANGLER, "d1", "execute", D1_NAME, "--remote", "--file", file], { stdio: "inherit" });
  }

  const fileDir = mkdtempSync(join(tmpdir(), "slack-import-file-"));
  for (const upload of result.pendingUploads) {
    const bytes = await client.downloadFile(upload.file.url_private!);
    if (!bytes) {
      console.warn(`slack-import: could not download ${upload.file.id} — metadata row exists, body missing (re-run to retry).`);
      continue;
    }
    const tmpFile = join(fileDir, upload.dubFileId);
    writeFileSync(tmpFile, Buffer.from(bytes));
    console.log(`slack-import: uploading ${upload.r2Key} (${bytes.byteLength} bytes)...`);
    execFileSync("pnpm", [...WRANGLER, "r2", "object", "put", `${R2_ATTACHMENT_BUCKET}/${upload.r2Key}`, "--file", tmpFile, "--remote"], {
      stdio: "inherit",
    });
  }

  console.log("slack-import: done (re-running is safe — every row is INSERT OR IGNORE on a Slack-derived id).");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
