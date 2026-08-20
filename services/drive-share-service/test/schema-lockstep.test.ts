// Drift guard: schema.ts (semantic source of truth for the `driveshare` namespace) MUST
// stay in lockstep with the physical migration infra applies
// (infra/d1/migrations/driveshare/0001_init.sql). Comparison ignores line comments and
// whitespace so only DDL changes trip the guard.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { DRIVESHARE_SCHEMA_MIGRATION } from "../src/schema";

const PHYSICAL_SQL_PATH = new URL("../../../infra/d1/migrations/driveshare/0001_init.sql", import.meta.url);

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
  it("drive-share-service schema const equals infra/d1/migrations/driveshare/0001_init.sql", () => {
    const physical = readFileSync(PHYSICAL_SQL_PATH, "utf8");
    expect(normalizeDdl(DRIVESHARE_SCHEMA_MIGRATION.up)).toBe(normalizeDdl(physical));
  });
});
