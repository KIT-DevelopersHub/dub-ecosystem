// Drift guard: schema.ts (semantic source of truth for the `member` namespace) MUST
// stay in lockstep with the physical migrations infra applies
// (infra/d1/migrations/member/<id>.sql). Comparison ignores line comments and
// whitespace so only DDL changes trip the guard. Every const in MEMBER_MIGRATIONS is
// checked against the .sql of the same id, so adding a migration to one side without
// the other fails here.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { MEMBER_MIGRATIONS } from "../src/schema";

const migrationUrl = (id: string): URL =>
  new URL(`../../../infra/d1/migrations/member/${id}.sql`, import.meta.url);

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
  for (const m of MEMBER_MIGRATIONS) {
    it(`member-service ${m.id} const equals infra/d1/migrations/member/${m.id}.sql`, () => {
      const physical = readFileSync(migrationUrl(m.id), "utf8");
      expect(normalizeDdl(m.up)).toBe(normalizeDdl(physical));
    });
  }
});
