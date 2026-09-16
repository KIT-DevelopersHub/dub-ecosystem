#!/usr/bin/env -S node --import tsx
// Slack history -> Dub fe6-chat (D1) importer — CLI entrypoint (方式A: Slack Web API).
//
// PREVIEW-FIRST (default, mirrors admin-notify-backfill.ts): fetches/parses/maps and
// writes the generated idempotent .sql to --out, but touches neither remote D1 nor R2.
// Real writes require BOTH --apply AND CLOUDFLARE_API_TOKEN (+ SLACK_BOT_TOKEN for a
// live, non-fixture run) — approval-gated, matching this repo's phase-gate rule
// (~/.claude/rules/dub-development-flow.md §5: フェーズ移行はユーザー許可時のみ).
//
// Two run modes:
//   --fixture-dir <dir>   Offline dry-run. Reads Slack-API-shaped JSON fixtures instead
//                          of the network (see infra/d1/fixtures/slack/README.md).
//                          --apply is refused in this mode — it can never touch prod.
//   --channels <ids>      Live mode. Requires SLACK_BOT_TOKEN (env or --token-file) and
//                          fetches straight from the Slack Web API (slackClient.ts).
//
// Usage:
//   # offline dry-run against the checked-in pilot fixtures (no token needed)
//   node --import tsx infra/d1/scripts/slack-import.ts \
//     --fixture-dir infra/d1/fixtures/slack \
//     --identity-export infra/d1/fixtures/slack/identity-users.json \
//     --system-user-id usr_system0000000000000001
//
//   # live preview (needs SLACK_BOT_TOKEN; still writes nothing to D1/R2)
//   SLACK_BOT_TOKEN=xoxb-... node --import tsx infra/d1/scripts/slack-import.ts \
//     --channels C_CONF_PUBLIC,C_CONF_CORE \
//     --system-user-id usr_system0000000000000001
//
//   # apply (writes to remote dub-core D1 + uploads attachments to R2)
//   CLOUDFLARE_API_TOKEN=... SLACK_BOT_TOKEN=xoxb-... \
//     node --import tsx infra/d1/scripts/slack-import.ts --channels ... --apply
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLedger, batchStatements, R2_ATTACHMENT_BUCKET, type SlackImportLedgerData } from "../src/slackImport";
import { createFixtureSlackSource } from "../src/slackFixtureSource";
import { createSlackClient } from "../src/slackClient";
import { runSlackImport, type IdentityUserExportRow, type SlackSource } from "../src/slackImportRun";

const WRANGLER = ["dlx", "wrangler@4.35.0"]; // matches infra/d1/scripts/admin-notify.ts
const D1_NAME = "dub-core";
const DEFAULT_LEDGER_PATH = join("infra", "d1", ".slack-import", "ledger.json");
const DEFAULT_BATCH_SIZE = 200; // D1 free-tier friendly per infra/d1/src/slackImport.ts batchStatements

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function loadLedger(path: string): ReturnType<typeof createLedger> {
  if (!existsSync(path)) return createLedger();
  const data = JSON.parse(readFileSync(path, "utf8")) as SlackImportLedgerData;
  return createLedger(data);
}

function saveLedger(path: string, ledger: ReturnType<typeof createLedger>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger.toJSON(), null, 2) + "\n", "utf8");
}

function loadIdentityExport(path: string | undefined): IdentityUserExportRow[] {
  if (!path) {
    console.warn("slack-import: --identity-export not given; no Slack user will be mapped to a Dub account (all messages fall back to unmapped-user handling).");
    return [];
  }
  return JSON.parse(readFileSync(path, "utf8")) as IdentityUserExportRow[];
}

/** Read the CURRENT remote identity_users (id, email) via wrangler — used when
 *  --identity-export is omitted in a live (non-fixture) run and CLOUDFLARE_API_TOKEN is
 *  present. Falls back to an empty export (never blocks a preview run). */
function readRemoteIdentityUsers(): IdentityUserExportRow[] {
  if (!process.env.CLOUDFLARE_API_TOKEN) return [];
  try {
    const out = execFileSync(
      "pnpm",
      [...WRANGLER, "d1", "execute", D1_NAME, "--remote", "--json", "--command", "SELECT id, email FROM identity_users"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = JSON.parse(out) as Array<{ results?: IdentityUserExportRow[] }>;
    return parsed.flatMap((block) => block.results ?? []);
  } catch (e) {
    console.warn("slack-import: could not read remote identity_users (treating as no mappings):", e instanceof Error ? e.message : e);
    return [];
  }
}

function writeSqlBatches(sql: string[], outDir: string, batchSize: number): string[] {
  mkdirSync(outDir, { recursive: true });
  const batches = batchStatements(sql, batchSize);
  const files: string[] = [];
  batches.forEach((batch, i) => {
    const file = join(outDir, `batch-${String(i + 1).padStart(3, "0")}.sql`);
    writeFileSync(file, batch.join("\n") + "\n", "utf8");
    files.push(file);
  });
  return files;
}

async function main(): Promise<void> {
  const fixtureDir = flag("fixture-dir");
  const channelsArg = flag("channels");
  const apply = has("apply");
  const systemUserId = flag("system-user-id");
  const ledgerPath = flag("ledger") ?? DEFAULT_LEDGER_PATH;
  const outDir = flag("out") ?? mkdtempSync(join(tmpdir(), "slack-import-"));
  const batchSize = Number(flag("batch-size") ?? DEFAULT_BATCH_SIZE);
  const unmappedPolicy = (flag("unmapped-policy") as "embed-name" | "skip-message" | undefined) ?? "embed-name";
  const includeAttachments = !has("no-attachments");

  if (!systemUserId) {
    console.error("slack-import: --system-user-id is required (fallback created_by/owner_id for unmapped Slack users).");
    process.exit(2);
  }
  if (apply && fixtureDir) {
    console.error("slack-import: --apply is refused together with --fixture-dir — fixtures are for dry-run only, never for writing to real D1/R2.");
    process.exit(2);
  }

  let source: SlackSource;
  let targetChannelIds: string[];
  let slackToken: string | undefined;

  if (fixtureDir) {
    source = createFixtureSlackSource(fixtureDir);
    const channels = await source.listChannels();
    targetChannelIds = channelsArg ? channelsArg.split(",") : channels.map((c) => c.id);
  } else {
    slackToken = process.env.SLACK_BOT_TOKEN;
    if (!slackToken) {
      console.error("slack-import: SLACK_BOT_TOKEN is required for a live run (or pass --fixture-dir for an offline dry-run).");
      process.exit(2);
    }
    if (!channelsArg) {
      console.error("slack-import: --channels <id1,id2,...> is required for a live run (the カンファ関連の指定チャンネル — public + private).");
      process.exit(2);
    }
    const client = createSlackClient({ token: slackToken });
    source = {
      listUsers: () => client.listUsers(),
      listChannels: () => client.listChannels(),
      historyForChannel: (id) => client.historyForChannel(id),
      repliesForThread: (id, ts) => client.repliesForThread(id, ts),
    };
    targetChannelIds = channelsArg.split(",");
  }

  const identityUsers = flag("identity-export") ? loadIdentityExport(flag("identity-export")) : fixtureDir ? [] : readRemoteIdentityUsers();
  const ledger = loadLedger(ledgerPath);

  const result = await runSlackImport({
    source,
    targetChannelIds,
    identityUsers,
    systemUserId,
    unmappedUserPolicy: unmappedPolicy,
    ledger,
    includeAttachments,
  });

  const s = result.summary;
  console.log(`# slack-import ${fixtureDir ? "DRY-RUN (fixtures)" : apply ? "APPLY" : "PREVIEW"}`);
  console.log(`# channels: ${s.channels}  messages: ${s.messages} (already imported: ${s.alreadyImportedMessages}, unmapped author: ${s.messagesSkippedUnmappedAuthor})`);
  console.log(`# reactions: ${s.reactions} (skipped: unmapped emoji ${s.reactionsSkippedUnmappedEmoji}, unmapped user ${s.reactionsSkippedUnmappedUser})`);
  console.log(`# attachments: ${s.attachments}`);
  console.log(`# total SQL statements: ${s.estimatedStatements}  (batches of ${batchSize}: ${Math.ceil(s.estimatedStatements / batchSize) || 0})`);
  console.log(`# channel id map: ${JSON.stringify(result.channelIds)}`);

  const files = writeSqlBatches(result.sql, outDir, batchSize);
  console.log(`# wrote ${files.length} SQL batch file(s) to ${outDir}`);

  saveLedger(ledgerPath, ledger);
  console.log(`# ledger persisted to ${ledgerPath} (re-running will skip everything already imported above)`);

  if (!apply) {
    console.log("\n# DRY-RUN — nothing written to remote D1/R2. Re-run with --apply (+ CLOUDFLARE_API_TOKEN) to write.");
    if (result.pendingUploads.length > 0) {
      console.log(`# ${result.pendingUploads.length} attachment(s) would be downloaded from Slack and uploaded to R2 bucket "${R2_ATTACHMENT_BUCKET}" on --apply.`);
    }
    return;
  }

  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.error("slack-import --apply: CLOUDFLARE_API_TOKEN is required.");
    process.exit(2);
  }

  for (const file of files) {
    console.log(`slack-import: applying ${file} to remote ${D1_NAME}...`);
    execFileSync("pnpm", [...WRANGLER, "d1", "execute", D1_NAME, "--remote", "--file", file], { stdio: "inherit" });
  }

  if (result.pendingUploads.length > 0) {
    if (!slackToken) throw new Error("unreachable: pendingUploads present without a live Slack token");
    const client = createSlackClient({ token: slackToken });
    for (const upload of result.pendingUploads) {
      const urlPrivate = upload.file.url_private;
      if (!urlPrivate) {
        console.warn(`slack-import: file ${upload.file.id} (${upload.file.name}) has no url_private — skipped.`);
        continue;
      }
      const bytes = await client.downloadFile(urlPrivate);
      if (!bytes) {
        console.warn(`slack-import: could not download ${upload.file.id} (${upload.file.name}) — file_meta row was still written, body is missing.`);
        continue;
      }
      const tmpFile = join(mkdtempSync(join(tmpdir(), "slack-import-file-")), upload.file.name);
      writeFileSync(tmpFile, Buffer.from(bytes));
      console.log(`slack-import: uploading ${upload.r2Key} (${bytes.byteLength} bytes)...`);
      execFileSync("pnpm", [...WRANGLER, "r2", "object", "put", `${R2_ATTACHMENT_BUCKET}/${upload.r2Key}`, "--file", tmpFile, "--remote"], {
        stdio: "inherit",
      });
    }
  }

  console.log("slack-import: done (idempotent — re-running with the same ledger only imports new history).");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
