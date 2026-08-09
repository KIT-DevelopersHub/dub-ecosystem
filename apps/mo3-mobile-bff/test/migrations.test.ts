import { describe, it, expect } from "vitest";
import { namespaceOf, tablesOf, isLintClean, lintMigration } from "@dub/db";
import { MOBILE_MIGRATIONS } from "../src/migrations";

describe("mobile migrations", () => {
  it("every migration is declared in the mobile namespace", () => {
    for (const m of MOBILE_MIGRATIONS) expect(m.namespace).toBe("mobile");
  });

  it("all tables touched stay inside the mobile_* namespace (no boundary violation)", () => {
    for (const m of MOBILE_MIGRATIONS) {
      for (const table of tablesOf(m.up)) {
        expect(namespaceOf(table)).toBe("mobile");
      }
    }
  });

  it("passes the @dub/db migration lint", () => {
    for (const m of MOBILE_MIGRATIONS) {
      const issues = lintMigration(m);
      expect(isLintClean(issues), JSON.stringify(issues)).toBe(true);
    }
  });

  it("creates exactly the P0 tables (devices + push_deliveries; change_log/mutations deferred)", () => {
    const tables = tablesOf(MOBILE_MIGRATIONS[0]!.up);
    expect(tables).toContain("mobile_devices");
    expect(tables).toContain("mobile_push_deliveries");
    expect(tables).not.toContain("mobile_change_log");
    expect(tables).not.toContain("mobile_mutations");
  });
});
