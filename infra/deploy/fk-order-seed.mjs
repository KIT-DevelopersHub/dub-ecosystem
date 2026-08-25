// Emit a locally-seeded SQLite's INSERT statements in foreign-key-dependency order
// (referenced tables first), prefixed with `PRAGMA defer_foreign_keys=true;`.
//
// WHY: Cloudflare D1's remote file import chunks a large file into several transactions and
// enforces foreign keys across those chunk boundaries. A plain `sqlite3 .dump` lists tables
// in creation order, which is not FK-safe (e.g. task_dependencies before task_tasks), so the
// import fails with `FOREIGN KEY constraint failed`. Ordering the tables topologically and
// deferring FK checks within each transaction makes the load succeed deterministically.
//
// Usage: node infra/deploy/fk-order-seed.mjs <path-to-sqlite>   # -> SQL on stdout
// Depends only on the `sqlite3` CLI (already required by setup-staging-resources.sh).
import { execFileSync } from "node:child_process";

const db = process.argv[2];
if (!db) {
  console.error("usage: fk-order-seed.mjs <sqlite-file>");
  process.exit(2);
}

const q = (sql) =>
  execFileSync("sqlite3", ["-noheader", "-batch", db, sql], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });

// All user tables (skip sqlite internal tables).
const tables = q(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
)
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

// Foreign-key edges: table -> set of tables it references (self-refs ignored; handled by
// defer_foreign_keys within the transaction).
const edges = {};
for (const t of tables) {
  edges[t] = new Set();
  const fk = q(`PRAGMA foreign_key_list(${t});`).trim();
  if (!fk) continue;
  for (const line of fk.split("\n")) {
    const ref = line.split("|")[2]; // column 3 = referenced table
    if (ref && ref !== t && tables.includes(ref)) edges[t].add(ref);
  }
}

// Topological order: a referenced table is emitted before the table that references it.
// Cycles across different tables (should not exist in this schema) fall back to input order.
const order = [];
const done = new Set();
const temp = new Set();
const visit = (t) => {
  if (done.has(t) || temp.has(t)) return;
  temp.add(t);
  for (const r of edges[t]) visit(r);
  temp.delete(t);
  done.add(t);
  order.push(t);
};
for (const t of tables) visit(t);

// Group INSERTs by table, then emit them in FK order.
const dump = execFileSync("sqlite3", [db, ".dump"], {
  encoding: "utf8",
  maxBuffer: 1 << 28,
});
const byTable = {};
for (const line of dump.split("\n")) {
  if (!line.startsWith("INSERT INTO")) continue;
  const m = line.match(/^INSERT INTO ["'`]?([A-Za-z0-9_]+)/);
  if (!m) continue;
  (byTable[m[1]] ??= []).push(line);
}

let out = "PRAGMA defer_foreign_keys=true;\n";
for (const t of order) if (byTable[t]) out += byTable[t].join("\n") + "\n";
// Any table not covered by the topo pass (defensive) — append last.
for (const t of Object.keys(byTable))
  if (!order.includes(t)) out += byTable[t].join("\n") + "\n";

process.stdout.write(out);
