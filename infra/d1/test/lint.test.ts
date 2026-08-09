import { describe, it, expect } from "vitest";
import { lintAll, lintAllErrors, sanitizeForLint } from "../src/lint-all";
import { collectMigrations } from "../src/collect";

describe("schema lint (#3)", () => {
  it("#3 has zero error-level issues across the frozen (non-draft) schema", () => {
    const errors = lintAllErrors();
    expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
  });

  it("lints every collected migration (drafts included in the report)", () => {
    const report = lintAll();
    expect(report.length).toBe(collectMigrations().length);
    expect(report.some((r) => r.namespace === "chat")).toBe(true);
  });

  it("strips trigger bodies so append-only triggers do not create false namespace violations", () => {
    const audit = collectMigrations().find((m) => m.namespace === "audit")!;
    expect(audit.up).toMatch(/CREATE TRIGGER/i);
    expect(sanitizeForLint(audit.up)).not.toMatch(/CREATE TRIGGER/i);
    // still keeps the table DDL
    expect(sanitizeForLint(audit.up)).toMatch(/CREATE TABLE audit_logs/i);
  });
});
