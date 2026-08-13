// Drift guard: schema.ts (semantic source of truth for the `member` namespace) MUST
// stay in lockstep with the physical migration infra applies
// (infra/d1/migrations/member/0001_init.sql). Comparison ignores line comments and
// whitespace so only DDL changes trip the guard.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { MEMBER_MIGRATIONS } from "../src/schema";

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
    it(`member-service schema const equals infra/d1/migrations/member/${m.id}.sql`, () => {
      const physical = readFileSync(
        new URL(`../../../infra/d1/migrations/member/${m.id}.sql`, import.meta.url),
        "utf8",
      );
      expect(normalizeDdl(m.up)).toBe(normalizeDdl(physical));
    });
  }
});
