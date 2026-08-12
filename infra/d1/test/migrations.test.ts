import { describe, it, expect } from "vitest";
import { NAMESPACES } from "@dub/db";
import { collectMigrations } from "../src/collect";
import { applyAll } from "../src/apply";
import { verifySchema, declaredTables } from "../src/verify-schema";
import { NAMESPACE_REGISTRY } from "../src/registry";
import { emptyD1, migratedD1 } from "./d1";

describe("aggregation + registry", () => {
  it("registry is in lockstep with the frozen NAMESPACES (18 entries)", () => {
    expect(NAMESPACE_REGISTRY.length).toBe(NAMESPACES.length);
    expect(NAMESPACE_REGISTRY.map((e) => e.ns)).toEqual([...NAMESPACES]);
  });

  it("collects at least one migration per non-dub namespace, ordered by NAMESPACES", () => {
    const migs = collectMigrations();
    const seen = new Set(migs.map((m) => m.namespace));
    for (const ns of NAMESPACES) {
      if (ns === "dub") continue;
      expect(seen.has(ns), `missing migrations for ${ns}`).toBe(true);
    }
    // order: namespace declaration order is non-decreasing
    const idx = migs.map((m) => NAMESPACES.indexOf(m.namespace));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });
});

describe("apply pipeline (#1, #2, #9)", () => {
  it("#1 applies every table on an empty DB and records the ledger", async () => {
    const { db, raw } = emptyD1();
    const res = await applyAll(db);
    expect(res.applied.length).toBeGreaterThan(0);
    expect(res.skipped).toEqual([]);

    const tables = new Set(
      (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
    );
    for (const t of declaredTables()) expect(tables.has(t), `table ${t} missing`).toBe(true);

    const ledger = raw.prepare("SELECT COUNT(*) AS c FROM dub_migrations").get() as { c: number };
    expect(Number(ledger.c)).toBe(collectMigrations().length);
  });

  it("#2 is idempotent — a second apply skips everything", async () => {
    const { db } = emptyD1();
    await applyAll(db);
    const res2 = await applyAll(db);
    expect(res2.applied).toEqual([]);
    expect(res2.skipped.length).toBe(collectMigrations().length);
  });
});

describe("verify (#4)", () => {
  it("reports ok on a freshly migrated DB", async () => {
    const { db } = await migratedD1();
    const res = await verifySchema(db);
    expect(res).toEqual({ ok: true, missingTables: [], drift: [] });
  });

  it("#4 detects content drift when a migration file changes", async () => {
    const { db } = await migratedD1();
    const mutated = collectMigrations().map((m) =>
      m.namespace === "seed" ? { ...m, up: m.up + "\n-- drifted\n" } : m,
    );
    const res = await verifySchema(db, mutated);
    expect(res.ok).toBe(false);
    expect(res.drift).toContain("seed/0001_init");
  });
});
