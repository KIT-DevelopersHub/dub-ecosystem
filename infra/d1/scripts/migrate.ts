// d1:migrate / d1:seed / d1:reset — operational CLI.
//
// Scope note (P0): only `--env local` is implemented here, backed by a node:sqlite file
// (fast local iteration + CI). preview/prod application runs through wrangler in the
// infra #27 CI pipeline (CF API token required, not this script) — the ledger/lint
// logic is shared via @dub/infra-d1 exports so both paths stay consistent.
import { existsSync, rmSync } from "node:fs";
import { applyAll } from "../src/apply";
import { verifySchema } from "../src/verify-schema";
import { fileD1 } from "../src/node-d1";
import { seedScenario, type SeedScenarioName } from "../seed/scenarios";

interface Args {
  cmd: "migrate" | "seed" | "reset";
  env: string;
  file: string;
  scenario: SeedScenarioName;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.find((a) => !a.startsWith("--"));
  const get = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
  };
  return {
    cmd: (positional as Args["cmd"]) ?? "migrate",
    env: get("env", "local"),
    file: get("file", ".wrangler/local-dub-core.sqlite"),
    scenario: get("scenario", "conference-demo") as SeedScenarioName,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.env !== "local") {
    console.error(`env "${args.env}" runs through the wrangler CI pipeline (infra #27), not this script.`);
    process.exit(2);
  }

  if (args.cmd === "reset" && existsSync(args.file)) rmSync(args.file);
  const { db } = fileD1(args.file);

  if (args.cmd === "migrate" || args.cmd === "reset") {
    const res = await applyAll(db);
    console.log(JSON.stringify({ migrate: res }, null, 2));
  }
  if (args.cmd === "seed" || args.cmd === "reset") {
    // databaseName is the local file name — never "dub-core", so the guard passes.
    const handle = await seedScenario(db, args.scenario, { databaseName: `local:${args.file}` });
    console.log(JSON.stringify({ seed: { scenario: handle.scenario, runId: handle.runId, inserted: handle.inserted } }, null, 2));
  }

  const verify = await verifySchema(db);
  console.log(JSON.stringify({ verify }, null, 2));
  if (!verify.ok) process.exit(1);
}

void main();
