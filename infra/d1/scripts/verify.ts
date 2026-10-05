// d1:lint (offline, no DB) and d1:verify:
//   verify                      -> local file DB (.wrangler/local-dub-core.sqlite)
//   verify --file <path>        -> another local sqlite file
//   verify --remote <db_name>   -> READ-ONLY audit of a remote D1 (prod / staging) via
//                                  wrangler; never writes (no ensureLedger, SELECT only).
// Remote examples:
//   node --import tsx scripts/verify.ts --remote dub-core
//   WRANGLER_BIN="node /path/to/wrangler.js" node --import tsx scripts/verify.ts --remote dub-core-staging
import { lintAllErrors } from "../src/lint-all";
import { verifySchema } from "../src/verify-schema";
import { fileD1 } from "../src/node-d1";
import { remoteD1 } from "../src/remote-d1";

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith("--")) ?? "verify";

  if (cmd === "lint") {
    const errors = lintAllErrors();
    if (errors.length === 0) {
      console.log("d1:lint OK — 0 error-level issues (drafts excluded).");
      return;
    }
    console.error(JSON.stringify(errors, null, 2));
    process.exit(1);
  }

  if (argv.includes("--remote")) {
    const database = flagValue(argv, "--remote");
    if (!database) {
      console.error("d1:verify --remote needs a database name, e.g. --remote dub-core");
      process.exit(2);
      return;
    }
    // Read-only: no ensureLedger, SELECT/PRAGMA only. Safe to point at prod.
    const res = await verifySchema(remoteD1(database), undefined, { readOnly: true });
    console.log(JSON.stringify({ target: `remote:${database}`, ...res }, null, 2));
    if (!res.ok) process.exit(1);
    return;
  }

  const file = flagValue(argv, "--file") ?? ".wrangler/local-dub-core.sqlite";
  const { db } = fileD1(file);
  const res = await verifySchema(db);
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exit(1);
}

void main();
