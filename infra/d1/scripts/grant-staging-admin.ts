// Grant role_sys_admin every PERMISSION_CATALOG key on a STAGING D1 (staging.yml, each deploy).
//
//   node --import tsx scripts/grant-staging-admin.ts dub-core-staging2
//   ... --dry-run   (print the SQL, write nothing)
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { STAGING_DB, stagingAdminGrantSql } from "../src/staging-admin-grant";

const argv = process.argv.slice(2);
const db = argv.find((a) => !a.startsWith("--"));
if (!db || !STAGING_DB.test(db)) {
  console.error(`usage: grant-staging-admin.ts <dub-core-staging|dub-core-staging2> [--dry-run] (got "${db ?? ""}")`);
  process.exit(2);
}

const sql = stagingAdminGrantSql();
if (argv.includes("--dry-run")) {
  console.log(sql);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "grant-staging-admin-"));
const file = join(dir, "grant.sql");
writeFileSync(file, `${sql}\n`);

const bin = (process.env.WRANGLER_BIN ?? "wrangler").trim().split(/\s+/);
const proc = spawnSync(
  bin[0]!,
  [...bin.slice(1), "d1", "execute", db, "--remote", "--yes", "--file", file],
  { cwd: dir, stdio: "inherit", env: process.env },
);
if (proc.status !== 0) {
  console.log(`::error title=staging admin grant (${db})::wrangler failed`);
  process.exit(1);
}
console.log(`${db}: role_sys_admin holds every PERMISSION_CATALOG key`);
