// Column-level schema verification (the prod member_people.leader_id incident) + the
// read-only / remote-adapter safety guards.
import { describe, it, expect } from "vitest";
import type { Migration } from "@dub/db";
import { collectMigrations } from "../src/collect";
import { applyAll } from "../src/apply";
import { declaredColumns, verifySchema } from "../src/verify-schema";
import { assertReadOnlySql, remoteD1, RemoteD1ReadOnlyError } from "../src/remote-d1";
import { emptyD1, migratedD1 } from "./d1";

// Words a constraint line starts with; a real column is never named any of these.
// ("key" is excluded on purpose — member_teams.key / mailauto_settings.key are real.)
const CONSTRAINT_WORDS = ["primary", "unique", "check", "foreign", "constraint", "exclude"];

function migrationsWithout(key: string): Migration[] {
  return collectMigrations().map((m) =>
    `${m.namespace}/${m.id}` === key ? { ...m, up: `-- ${key} intentionally NOT applied (test)\n` } : m,
  );
}

describe("declaredColumns — DDL parser over the real migrations", () => {
  const declared = declaredColumns();

  it("sees ALTER TABLE ... ADD COLUMN (member_people.leader_id — the prod incident)", () => {
    expect(declared.get("member_people")?.has("leader_id")).toBe(true);
    // other additive ALTERs on the same table
    for (const col of ["identity_user_id", "department", "grade", "school_email", "gmail", "desired_activity"]) {
      expect(declared.get("member_people")?.has(col), `member_people.${col}`).toBe(true);
    }
  });

  it("sees a multi-line ALTER with a trailing CHECK (notif_notifications.audience)", () => {
    expect(declared.get("notif_notifications")?.has("audience")).toBe(true);
  });

  it("merges a table rebuild with later ALTERs (task_tasks)", () => {
    const cols = declared.get("task_tasks");
    // from the 0003 rebuild body
    expect(cols?.has("event_id")).toBe(true);
    // from 0004 / 0005 ALTERs that come after the rebuild
    for (const col of ["team_id", "parent_id", "wbs", "start_at"]) expect(cols?.has(col), col).toBe(true);
    // the rename-aside temp table is never a declared table
    expect(declared.has("task_tasks_old")).toBe(false);
  });

  it("never mistakes a table constraint line for a column", () => {
    for (const [table, cols] of declared) {
      for (const col of cols) {
        expect(CONSTRAINT_WORDS, `${table}.${col} looks like a constraint keyword`).not.toContain(col.toLowerCase());
      }
    }
    // PRIMARY KEY (person_id, team_id) must not add columns beyond the real four
    expect([...(declared.get("member_team_links") ?? [])].sort()).toEqual([
      "created_at",
      "person_id",
      "team_id",
      "updated_at",
    ]);
  });

  it("matches the real applied schema EXACTLY (no false positives, no misses)", async () => {
    const { db, raw } = await migratedD1();
    const live = new Map<string, Set<string>>();
    const rows = raw
      .prepare(
        "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table'",
      )
      .all() as Array<{ tbl: string; col: string }>;
    for (const r of rows) {
      if (!live.has(r.tbl)) live.set(r.tbl, new Set());
      live.get(r.tbl)!.add(r.col);
    }

    expect(declared.size).toBeGreaterThan(50);
    for (const [table, cols] of declared) {
      expect([...cols].sort(), `columns of ${table}`).toEqual([...(live.get(table) ?? new Set())].sort());
    }
    const res = await verifySchema(db);
    expect(res.missingColumns).toEqual([]);
  });
});

describe("declaredColumns — synthetic DDL edge cases", () => {
  const parse = (up: string) => declaredColumns([{ namespace: "seed", id: "0001_x", up } as Migration]);

  it("ignores prose comments that contain DDL keywords", () => {
    const cols = parse(`
      -- ALTER TABLE t ADD COLUMN ghost TEXT; and CREATE TABLE phantom (x TEXT);
      /* block: ADD COLUMN ghost2 TEXT */
      CREATE TABLE t (id TEXT PRIMARY KEY);
    `);
    expect([...cols.keys()]).toEqual(["t"]);
    expect([...cols.get("t")!]).toEqual(["id"]);
  });

  it("handles quoted identifiers, IF NOT EXISTS, trailing commas and constraint lines", () => {
    const cols = parse(`
      CREATE TABLE IF NOT EXISTS "quo ted" (
        "odd name" TEXT NOT NULL,
        \`back\` TEXT,
        plain TEXT DEFAULT 'a,b(c)',
        CHECK (plain IN ('a,b(c)','d')),
        UNIQUE (plain),
        PRIMARY KEY ("odd name", plain),
        FOREIGN KEY (plain) REFERENCES other(x),
        CONSTRAINT ck_x CHECK (length(plain) > 0)
      );
    `);
    expect([...cols.get("quo ted")!].sort()).toEqual(["back", "odd name", "plain"]);
  });

  it("merges IF NOT EXISTS re-declarations but lets a plain CREATE (rebuild) replace", () => {
    const merged = parse(`
      CREATE TABLE IF NOT EXISTS t (a TEXT);
      ALTER TABLE t ADD COLUMN b TEXT;
      CREATE TABLE IF NOT EXISTS t (a TEXT);
    `);
    expect([...merged.get("t")!].sort()).toEqual(["a", "b"]);

    const rebuilt = parse(`
      CREATE TABLE t (a TEXT, gone TEXT);
      ALTER TABLE t RENAME TO t_old;
      CREATE TABLE t (a TEXT);
      DROP TABLE t_old;
    `);
    expect([...rebuilt.get("t")!]).toEqual(["a"]);
    expect(rebuilt.has("t_old")).toBe(false);
  });

  it("applies ADD / DROP / RENAME COLUMN and bare ADD", () => {
    const cols = parse(`
      CREATE TABLE t (a TEXT, b TEXT, c TEXT);
      ALTER TABLE t ADD d TEXT;
      ALTER TABLE t DROP COLUMN b;
      ALTER TABLE t RENAME COLUMN c TO c2;
    `);
    expect([...cols.get("t")!].sort()).toEqual(["a", "c2", "d"]);
  });

  it("ignores CREATE INDEX / TRIGGER / VIEW and CREATE TABLE ... AS SELECT", () => {
    const cols = parse(`
      CREATE TABLE t (a TEXT);
      CREATE INDEX idx_t ON t(a) WHERE a IS NOT NULL;
      CREATE VIEW v AS SELECT a FROM t;
      CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = 'x'; END;
      CREATE TABLE copy AS SELECT a FROM t;
    `);
    expect([...cols.keys()]).toEqual(["t"]);
  });
});

describe("verifySchema — missing column detection", () => {
  it("flags member_people.leader_id when migration member/0010 was never applied", async () => {
    const { db } = emptyD1();
    await applyAll(db, migrationsWithout("member/0010_person_leader"));

    const res = await verifySchema(db); // verified against the REAL migrations
    expect(res.ok).toBe(false);
    expect(res.missingColumns).toContain("member_people.leader_id");
    expect(res.missingTables).toEqual([]); // the table itself exists
    expect(res.drift).toContain("member/0010_person_leader");
  });

  it("does not report columns of a table that is missing entirely (no double reporting)", async () => {
    const { db } = emptyD1();
    await applyAll(
      db,
      collectMigrations().filter((m) => `${m.namespace}/${m.id}` !== "driveshare/0001_init"),
    );
    const res = await verifySchema(db);
    expect(res.missingTables).toContain("driveshare_role_file_grants");
    expect(res.missingColumns.some((c) => c.startsWith("driveshare_role_file_grants."))).toBe(false);
  });

  it("still detects content drift and missing tables (regression)", async () => {
    const { db } = await migratedD1();
    const mutated = collectMigrations().map((m) =>
      m.namespace === "seed" ? { ...m, up: m.up + "\n-- drifted\n" } : m,
    );
    const res = await verifySchema(db, mutated);
    expect(res.ok).toBe(false);
    expect(res.drift).toContain("seed/0001_init");
  });
});

describe("verifySchema — read-only mode never writes", () => {
  function spy(db: Awaited<ReturnType<typeof migratedD1>>["db"]): { db: typeof db; sql: string[] } {
    const sql: string[] = [];
    const wrapped = {
      prepare(q: string) {
        sql.push(q);
        return db.prepare(q);
      },
      exec(q: string) {
        sql.push(q);
        return db.exec(q);
      },
    } as unknown as typeof db;
    return { db: wrapped, sql };
  }

  const WRITES = /\b(create|insert|update|delete|alter|drop|replace)\b/i;

  it("issues no write SQL and does not create the ledger on an empty DB", async () => {
    const { db, raw } = emptyD1();
    const { db: watched, sql } = spy(db);

    const res = await verifySchema(watched, collectMigrations(), { readOnly: true });

    expect(sql.length).toBeGreaterThan(0);
    for (const q of sql) expect(q, `write SQL issued: ${q}`).not.toMatch(WRITES);
    const ledger = raw.prepare("SELECT name FROM sqlite_master WHERE name = 'dub_migrations'").get();
    expect(ledger).toBeUndefined();
    expect(res.ledgerPresent).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.drift.length).toBe(collectMigrations().length); // nothing applied
  });

  it("writes the ledger in the default (read-write) mode — unchanged behaviour", async () => {
    const { db, raw } = emptyD1();
    const res = await verifySchema(db);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'dub_migrations'").get()).toBeTruthy();
    expect(res.ledgerPresent).toBe(true);
  });

  it("reports ok in read-only mode against a properly migrated DB", async () => {
    const { db } = await migratedD1();
    const res = await verifySchema(db, collectMigrations(), { readOnly: true });
    expect(res).toEqual({ ok: true, missingTables: [], missingColumns: [], drift: [], ledgerPresent: true });
  });
});

describe("remoteD1 — read-only guard", () => {
  // wranglerBin points at a non-existent binary: if the guard ever let SQL through,
  // these tests would fail with a spawn error instead of RemoteD1ReadOnlyError.
  const db = remoteD1("dub-core", { wranglerBin: "/nonexistent/wrangler-should-never-run" });

  it("allows a single SELECT and a read-form PRAGMA", () => {
    expect(() => assertReadOnlySql("SELECT name FROM sqlite_master WHERE type = 'table'")).not.toThrow();
    expect(() => assertReadOnlySql("SELECT 1;")).not.toThrow();
    expect(() => assertReadOnlySql("PRAGMA table_info(member_people)")).not.toThrow();
  });

  it("rejects every write statement", () => {
    for (const sql of [
      "INSERT INTO member_people (id) VALUES ('x')",
      "UPDATE member_people SET name = 'x'",
      "DELETE FROM member_people",
      "ALTER TABLE member_people ADD COLUMN leader_id TEXT",
      "CREATE TABLE IF NOT EXISTS dub_migrations (namespace TEXT)",
      "DROP TABLE member_people",
      "REPLACE INTO member_people (id) VALUES ('x')",
      "ATTACH DATABASE 'x' AS y",
      "WITH x AS (SELECT 1) INSERT INTO member_people (id) SELECT 1 FROM x",
      "PRAGMA foreign_keys = OFF",
      "VACUUM",
      "",
    ]) {
      expect(() => assertReadOnlySql(sql), sql).toThrow(RemoteD1ReadOnlyError);
    }
  });

  it("rejects a second statement smuggled after a SELECT, comments included", () => {
    expect(() => assertReadOnlySql("SELECT 1; DROP TABLE member_people")).toThrow(/2 statements/);
    expect(() => assertReadOnlySql("SELECT 1; -- harmless?\nDELETE FROM member_people")).toThrow(
      RemoteD1ReadOnlyError,
    );
    // a `;` inside a string literal is NOT a statement boundary
    expect(() => assertReadOnlySql("SELECT ';' AS x")).not.toThrow();
  });

  it("refuses at prepare() time, before any process is spawned", () => {
    expect(() => db.prepare("ALTER TABLE member_people ADD COLUMN leader_id TEXT")).toThrow(RemoteD1ReadOnlyError);
    expect(() => db.prepare("CREATE TABLE t (a TEXT)")).toThrow(RemoteD1ReadOnlyError);
    expect(() => db.prepare("INSERT INTO t VALUES (1)")).toThrow(RemoteD1ReadOnlyError);
  });

  it("refuses exec() outright — that is the ensureLedger/DDL path", () => {
    expect(() => db.exec("CREATE TABLE IF NOT EXISTS dub_migrations (x TEXT)")).toThrow(RemoteD1ReadOnlyError);
  });

  it("rejects a suspicious database name", () => {
    expect(() => remoteD1("dub-core; rm -rf /")).toThrow(/suspicious database name/);
  });
});
