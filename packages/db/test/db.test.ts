import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import {
  NAMESPACES,
  namespaceOf,
  isTableInNamespace,
  tablesOf,
  newId,
  nowIso,
  ulid,
  createDbClient,
  applyMigrations,
  hashMigration,
  lintSql,
  lintMigration,
  isLintClean,
  type Migration,
} from "../src/index";

// ---- minimal in-memory D1 fake (matches only the SQL our code issues) ----
function fakeD1() {
  const ledger = new Map<string, { hash: string }>();
  const executed: string[] = [];
  const failOn: { substr?: string } = {};

  const makeStmt = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...b: unknown[]) {
        bound = b;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (sql.startsWith("SELECT hash FROM dub_migrations")) {
          const key = `${bound[0]}|${bound[1]}`;
          return (ledger.get(key) ?? null) as T | null;
        }
        return null;
      },
      async all<T>() {
        return { results: [] as T[], success: true, meta: {} };
      },
      async run() {
        executed.push(sql);
        if (failOn.substr && sql.includes(failOn.substr)) throw new Error("boom");
        if (sql.startsWith("INSERT INTO dub_migrations")) {
          ledger.set(`${bound[0]}|${bound[1]}`, { hash: String(bound[2]) });
        }
        return { success: true, meta: { changes: 1, last_row_id: 1, duration: 0 } };
      },
    };
    return stmt;
  };

  const d1 = {
    prepare: (sql: string) => makeStmt(sql),
    async batch(stmts: unknown[]) {
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  } as unknown as D1Database;

  return { d1, executed, failOn };
}

describe("@dub/db namespaces + ids", () => {
  it("freezes 19 namespaces and resolves longest-prefix", () => {
    expect(NAMESPACES.length).toBe(19);
    expect(namespaceOf("file_meta_files")).toBe("file_meta");
    expect(namespaceOf("task_dependencies")).toBe("task");
    expect(namespaceOf("unknown_table")).toBe(null);
    expect(isTableInNamespace("task_tasks", "task")).toBe(true);
    expect(isTableInNamespace("task_tasks", "event")).toBe(false);
  });

  it("parses tables from JOINs/subqueries", () => {
    const t = tablesOf("SELECT * FROM task_tasks t JOIN task_deps d ON d.task_id = t.id WHERE t.id IN (SELECT id FROM task_archive)");
    expect(t).toContain("task_tasks");
    expect(t).toContain("task_deps");
    expect(t).toContain("task_archive");
  });

  it("does not mis-parse the ON CONFLICT DO UPDATE SET keyword as a table (regression)", () => {
    // `... DO UPDATE SET` (upsert) trails "SET" after "UPDATE"; it must NOT be captured
    // as a table, or every upsert raises a spurious DB_NAMESPACE_VIOLATION.
    const t = tablesOf(
      "INSERT INTO member_participations (id, name) VALUES (?, ?) " +
        "ON CONFLICT(org_id, normalized_name) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
    );
    expect(t).toEqual(["member_participations"]);
    expect(t).not.toContain("SET");
    // A genuine cross-table UPDATE still resolves its real table.
    expect(tablesOf("UPDATE member_people SET archived_at = ? WHERE id = ?")).toEqual(["member_people"]);
  });

  it("newId is prefixed + lexicographically time-ordered; nowIso is UTC ISO", () => {
    const a = newId("task");
    expect(a.startsWith("task_")).toBe(true);
    const early = ulid(1);
    const late = ulid(2_000_000_000_000);
    expect(early < late).toBe(true);
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(new Set([newId("x"), newId("x"), newId("x")]).size).toBe(3);
  });
});

describe("@dub/db client enforcement", () => {
  it("rejects cross-namespace access in strict mode", async () => {
    const { d1 } = fakeD1();
    const c = createDbClient(d1, { namespace: "task" });
    await expect(c.all("SELECT * FROM event_events")).rejects.toMatchObject({ code: "DB_NAMESPACE_VIOLATION" });
    await expect(c.run("INSERT INTO identity_users (id) VALUES (?)", "u1")).rejects.toMatchObject({ code: "DB_NAMESPACE_VIOLATION" });
  });

  it("allows own-namespace access", async () => {
    const { d1, executed } = fakeD1();
    const c = createDbClient(d1, { namespace: "task" });
    await c.run("INSERT INTO task_tasks (id) VALUES (?)", "t1");
    expect(executed.some((s) => s.includes("task_tasks"))).toBe(true);
  });

  it("allows a same-namespace ON CONFLICT DO UPDATE SET upsert (regression)", async () => {
    // Reproduces the participation 500: strict enforcement must NOT reject an own-namespace
    // upsert just because it contains `DO UPDATE SET`.
    const { d1, executed } = fakeD1();
    const c = createDbClient(d1, { namespace: "member" });
    await c.run(
      "INSERT INTO member_participations (id, name) VALUES (?, ?) " +
        "ON CONFLICT(org_id, normalized_name) DO UPDATE SET name = excluded.name",
      "p1",
      "山田 太郎",
    );
    expect(executed.some((s) => s.includes("member_participations"))).toBe(true);
  });

  it("forbids runtime DDL via the client (raw() only)", async () => {
    const { d1 } = fakeD1();
    const c = createDbClient(d1, { namespace: "task" });
    await expect(c.run("CREATE TABLE task_new (id TEXT)")).rejects.toMatchObject({ code: "DB_FORBIDDEN_STATEMENT" });
    await expect(c.run("DROP TABLE task_tasks")).rejects.toMatchObject({ code: "DB_FORBIDDEN_STATEMENT" });
  });

  it("warn mode logs but allows", async () => {
    const { d1 } = fakeD1();
    const logs: string[] = [];
    const c = createDbClient(d1, { namespace: "task", enforcement: "warn", logger: (e) => logs.push(e.sql) });
    await c.all("SELECT * FROM event_events");
    expect(logs.some((l) => l.includes("[warn]"))).toBe(true);
  });
});

describe("@dub/db migrations", () => {
  const migs: Migration[] = [
    { namespace: "identity", id: "0001_init", up: "CREATE TABLE identity_users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" },
    { namespace: "task", id: "0001_init", up: "CREATE TABLE task_tasks (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" },
  ];

  it("applies pending migrations then is idempotent on re-run", async () => {
    const { d1 } = fakeD1();
    const first = await applyMigrations(d1, migs);
    expect(first.every((r) => r.status === "applied")).toBe(true);
    const second = await applyMigrations(d1, migs);
    expect(second.every((r) => r.status === "skipped")).toBe(true);
  });

  it("applies in NAMESPACES declaration order (identity before task)", async () => {
    const { d1 } = fakeD1();
    const res = await applyMigrations(d1, [migs[1]!, migs[0]!]);
    expect(res.map((r) => r.namespace)).toEqual(["identity", "task"]);
  });

  it("detects content drift", async () => {
    const { d1 } = fakeD1();
    await applyMigrations(d1, migs);
    const drifted: Migration[] = [{ ...migs[0]!, up: migs[0]!.up + " -- changed" }];
    const res = await applyMigrations(d1, drifted);
    expect(res[0]?.status).toBe("failed");
    expect(res[0]?.error).toContain("DRIFT");
  });

  it("halts subsequent migrations after a failure", async () => {
    const { d1, failOn } = fakeD1();
    failOn.substr = "identity_users";
    const res = await applyMigrations(d1, migs);
    expect(res[0]?.status).toBe("failed");
    expect(res[1]?.status).toBe("skipped");
  });

  it("hashMigration is stable and content-sensitive", () => {
    expect(hashMigration("a")).toBe(hashMigration("a"));
    expect(hashMigration("a")).not.toBe(hashMigration("b"));
  });
});

describe("@dub/db lint", () => {
  it("flags namespace violations, cross-ns FK, forbidden statements", () => {
    const bad = lintSql(
      "CREATE TABLE event_things (id TEXT, owner TEXT REFERENCES identity_users(id));",
      "task",
    );
    const rules = bad.map((i) => i.rule);
    expect(rules).toContain("namespace-violation");
    expect(rules).toContain("cross-namespace-fk");
    expect(isLintClean(bad)).toBe(false);

    expect(lintSql("PRAGMA foreign_keys=ON;", "task").some((i) => i.rule === "forbidden-statement")).toBe(true);
  });

  it("missing-timestamps is warn (not error) and exemptions are clean", () => {
    const warned = lintMigration({ namespace: "task", id: "0002_x", up: "CREATE TABLE task_notes (id TEXT PRIMARY KEY);" });
    expect(warned.some((i) => i.rule === "missing-timestamps" && i.level === "warn")).toBe(true);
    expect(isLintClean(warned)).toBe(true); // warn does not fail the gate

    const exempt = lintMigration({ namespace: "task", id: "0003_deps", up: "CREATE TABLE task_dependencies (task_id TEXT, depends_on_id TEXT);" });
    expect(exempt.some((i) => i.rule === "missing-timestamps")).toBe(false);
  });

  it("passes a clean well-formed migration", () => {
    const ok = lintMigration({
      namespace: "task",
      id: "0001_init",
      up: "CREATE TABLE task_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
    });
    expect(isLintClean(ok)).toBe(true);
  });
});
