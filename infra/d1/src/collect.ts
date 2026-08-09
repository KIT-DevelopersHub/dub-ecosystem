// Physical migration aggregation: read every migrations/<ns>/*.sql from disk and
// present them as @dub/db Migration[] in deterministic order (NAMESPACES declaration
// order -> id ascending). The .sql files are the 正本 (theme-12); this is the loader.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NAMESPACES, type Migration, type Namespace } from "@dub/db";

// migrations/ sits next to src/ inside infra/d1.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function listSql(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // filenames start with a 4-digit seq -> lexical sort == id ascending
}

/** All aggregated migrations, ordered by NAMESPACES then id. `dub` is skipped
 *  (its ledger is created by ensureLedger, not a migration file). */
export function collectMigrations(migrationsDir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const ns of NAMESPACES) {
    if (ns === "dub") continue;
    const dir = join(migrationsDir, ns);
    for (const file of listSql(dir)) {
      const id = file.replace(/\.sql$/, "");
      const up = readFileSync(join(dir, file), "utf8").trim();
      out.push({ namespace: ns as Namespace, id, up });
    }
  }
  return out;
}

export { MIGRATIONS_DIR };
