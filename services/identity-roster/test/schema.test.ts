import { describe, it, expect } from "vitest";
import { lintMigration, isLintClean } from "@dub/db";
import { IDENTITY_MIGRATIONS } from "../src/schema";

describe("identity migrations conform to @dub/db SQL lint", () => {
  it("has no error-level lint issues (namespace, naming, cross-ns FK)", () => {
    for (const m of IDENTITY_MIGRATIONS) {
      const issues = lintMigration(m);
      const errorsOnly = issues.filter((i) => i.level === "error");
      expect(errorsOnly, `migration ${m.id}: ${JSON.stringify(errorsOnly)}`).toEqual([]);
      expect(isLintClean(issues)).toBe(true);
    }
  });

  it("stays within the identity namespace", () => {
    expect(IDENTITY_MIGRATIONS.every((m) => m.namespace === "identity")).toBe(true);
    expect(IDENTITY_MIGRATIONS.map((m) => m.id)).toEqual(["0001_init", "0002_system_roles"]);
  });
});
