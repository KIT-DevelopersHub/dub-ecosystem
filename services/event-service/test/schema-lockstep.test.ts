// Drift guard: schema.ts (the semantic source of truth for the `event` namespace)
// MUST stay in lockstep with the physical migration that infra actually applies
// (infra/d1/migrations/event/0001_init.sql). If the two drift, reads/writes in
// d1-repo.ts silently diverge from the deployed table. Comparison ignores SQL line
// comments and whitespace so cosmetic edits don't trip the guard — only DDL changes do.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { EVENT_SCHEMA_MIGRATION } from "../src/schema";

// From services/event-service/ up to the repo root, then into infra.
const PHYSICAL_SQL_PATH = new URL(
  "../../../infra/d1/migrations/event/0001_init.sql",
  import.meta.url,
);

/** Strip `-- ...` line comments, collapse all whitespace, drop trailing `;`. */
function normalizeDdl(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*/g, ";")
    .replace(/;$/, "")
    .trim();
}

describe("schema.ts <-> physical migration lockstep", () => {
  it("event-service schema const equals infra/d1/migrations/event/0001_init.sql", () => {
    const physical = readFileSync(PHYSICAL_SQL_PATH, "utf8");
    expect(normalizeDdl(EVENT_SCHEMA_MIGRATION.up)).toBe(normalizeDdl(physical));
  });
});
