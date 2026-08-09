// d1:lint (offline, no DB) and d1:verify (drift + presence against a local file DB).
import { lintAllErrors } from "../src/lint-all";
import { verifySchema } from "../src/verify-schema";
import { fileD1 } from "../src/node-d1";

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

  const fileIdx = argv.indexOf("--file");
  const file = fileIdx >= 0 && argv[fileIdx + 1] ? argv[fileIdx + 1]! : ".wrangler/local-dub-core.sqlite";
  const { db } = fileD1(file);
  const res = await verifySchema(db);
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exit(1);
}

void main();
