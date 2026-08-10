import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lintMigration, isLintClean, namespaceOf, tablesOf } from "@dub/db";
import { TASK_MIGRATIONS } from "../src/migrations";

// The service keeps a self-contained @dub/db Migration[] copy of its DDL
// (src/migrations.ts) whose 正本 (source of truth) is the physical migration under
// infra/d1/migrations/task/. This suite realizes that module's documented purpose:
// it must lint clean, stay inside the `task` namespace, and never silently drift
// from the physical migration it mirrors.

// Strip SQL line comments + collapse whitespace so the comparison is about schema
// content (statements), not formatting or header comments.
function normalizeDdl(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const physicalSqlPath = fileURLToPath(
  new URL("../../../infra/d1/migrations/task/0001_init.sql", import.meta.url),
);

describe("TASK_MIGRATIONS", () => {
  it("lints clean under @dub/db (no error-level issues)", () => {
    for (const m of TASK_MIGRATIONS) {
      const issues = lintMigration(m);
      expect(isLintClean(issues), `${m.id}: ${JSON.stringify(issues)}`).toBe(true);
    }
  });

  it("declares exactly the task-namespace tables, all inside `task`", () => {
    const tables = TASK_MIGRATIONS.flatMap((m) => tablesOf(m.up)).sort();
    expect(tables).toEqual(["task_dependencies", "task_idempotency", "task_tasks"]);
    for (const t of tables) expect(namespaceOf(t)).toBe("task");
    for (const m of TASK_MIGRATIONS) expect(m.namespace).toBe("task");
  });

  it("does not drift from the physical 正本 migration (infra/d1/migrations/task)", () => {
    const physical = readFileSync(physicalSqlPath, "utf8");
    const embedded = TASK_MIGRATIONS.map((m) => m.up).join("\n");
    expect(normalizeDdl(embedded)).toBe(normalizeDdl(physical));
  });
});
