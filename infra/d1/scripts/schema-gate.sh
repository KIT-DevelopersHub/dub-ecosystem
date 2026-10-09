#!/usr/bin/env bash
# Pre-deploy D1 schema gate: READ-ONLY comparison of a remote D1 against the repo's
# aggregated migrations (scripts/verify.ts --remote). Migrations are applied out-of-band,
# so new code can ship against a DB that lacks its tables/columns (member/0010 left
# member_people unwritable in prod for 14 days). This surfaces that before the deploy.
#
# Gates only on missingTables / missingColumns. The `drift` list (ledger rows) is ignored:
# prod has no dub_migrations ledger, so every migration reads as drift there.
#
# Usage: schema-gate.sh <database_name>
#   D1_SCHEMA_GATE=enforce  -> fail on missing schema (default)
#   D1_SCHEMA_GATE=warn     -> annotate and pass (escape hatch)
set -euo pipefail

DB="${1:?usage: schema-gate.sh <database_name>}"
MODE="${D1_SCHEMA_GATE:-enforce}"
cd "$(dirname "$0")/.."

export WRANGLER_BIN="${WRANGLER_BIN:-pnpm dlx wrangler@4.35.0}"
OUT="$(mktemp)"
# verify.ts exits 1 whenever ok=false (incl. ledger drift); judge from the JSON instead.
node --import tsx scripts/verify.ts --remote "$DB" > "$OUT" || true

node - "$OUT" "$DB" "$MODE" <<'EOF'
const fs = require("node:fs");
const [file, db, mode] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
let res;
try {
  res = JSON.parse(text.slice(text.indexOf("{")));
} catch {
  console.log(`::error title=D1 schema gate::could not read schema of ${db}`);
  console.log(text.slice(-2000));
  process.exit(mode === "enforce" ? 1 : 0);
}
const tables = (res.missingTables ?? []).filter((t) => t !== "dub_migrations");
const columns = res.missingColumns ?? [];
if (tables.length === 0 && columns.length === 0) {
  console.log(`D1 schema gate: ${db} has every table/column the migrations declare.`);
  process.exit(0);
}
const level = mode === "enforce" ? "error" : "warning";
const detail = [
  tables.length ? `missing tables: ${tables.join(", ")}` : "",
  columns.length ? `missing columns: ${columns.join(", ")}` : "",
].filter(Boolean).join(" / ");
console.log(`::${level} title=D1 schema gate (${db})::${detail} — apply only the matching files: pnpm dlx wrangler@4.35.0 d1 execute ${db} --remote --yes --file infra/d1/migrations/<ns>/<file>.sql`);
process.exit(mode === "enforce" ? 1 : 0);
EOF
