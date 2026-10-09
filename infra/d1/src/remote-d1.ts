// READ-ONLY D1 adapter over `wrangler d1 execute <db> --remote --json`. Lets
// `d1:verify --remote <database_name>` audit the real prod / staging schema (the hole
// that let member_people.leader_id stay missing in prod for two weeks: nothing ever
// looked at a remote D1 — only .wrangler/*.sqlite).
//
// SAFETY (this thing points at PRODUCTION):
//   - every statement passes assertReadOnlySql() before a process is spawned: exactly
//     one statement, and it must start with SELECT (or a non-assigning PRAGMA);
//   - the guard runs at prepare() time AND again on the final (bind-substituted) SQL;
//   - exec() always throws — it is the DDL path (ensureLedger), which read-only mode
//     must never reach.
// Node-only tooling. NEVER bundled into a Worker.
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { D1Database } from "@cloudflare/workers-types";
import { sqlStatementList } from "./sql-text";

export interface RemoteD1Options {
  /** wrangler command. May include leading args, e.g. "node /path/to/wrangler.js".
   *  Default: $WRANGLER_BIN, else "wrangler" from PATH. */
  wranglerBin?: string;
  /** cwd for wrangler. Default: os.tmpdir() — deliberately NOT the repo, so a
   *  wrangler.toml/jsonc lying around can never redirect or bind anything. */
  cwd?: string;
  /** Per-query timeout (ms). Default 120_000. */
  timeoutMs?: number;
}

/** Thrown when something tries to run non-read-only SQL through this adapter. */
export class RemoteD1ReadOnlyError extends Error {
  constructor(message: string) {
    super(`remote-d1 refused non read-only SQL (${message})`);
    this.name = "RemoteD1ReadOnlyError";
  }
}

/**
 * Allow exactly one SELECT, or one read-form PRAGMA. Everything else throws.
 *
 * Statement splitting is quote/comment aware, so neither `; DROP ...` smuggled after a
 * SELECT nor a `--` comment can slip past. A `PRAGMA x = y` SETS state, so assignment
 * form is rejected; only introspection pragmas (table_info etc.) are allowed. `WITH` is
 * rejected outright because SQLite allows `WITH ... INSERT/UPDATE/DELETE`.
 */
export function assertReadOnlySql(sql: string): void {
  const statements = sqlStatementList(sql);
  if (statements.length === 0) throw new RemoteD1ReadOnlyError("empty SQL");
  if (statements.length > 1) throw new RemoteD1ReadOnlyError(`${statements.length} statements in one query`);

  const stmt = statements[0]!;
  const head = /^[A-Za-z_]+/.exec(stmt)?.[0]?.toLowerCase();
  if (head === "select") return;
  if (head === "pragma") {
    if (stmt.includes("=")) throw new RemoteD1ReadOnlyError("PRAGMA assignment");
    return;
  }
  throw new RemoteD1ReadOnlyError(`leading keyword "${head ?? stmt.slice(0, 16)}"`);
}

function quoteLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`remote-d1: cannot bind non-finite number ${v}`);
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  throw new TypeError(`remote-d1: unsupported bind type ${typeof v}`);
}

/** `wrangler d1 execute` has no parameter binding, so binds are inlined as literals.
 *  The read-only guard re-runs on the substituted SQL, so an injected statement is
 *  still rejected. */
function inlineBinds(sql: string, args: readonly unknown[]): string {
  if (args.length === 0) return sql;
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    if (i >= args.length) throw new RangeError("remote-d1: more ? placeholders than bound values");
    return quoteLiteral(args[i++]);
  });
  if (i !== args.length) throw new RangeError("remote-d1: more bound values than ? placeholders");
  return out;
}

interface WranglerResult {
  results?: unknown[];
  success?: boolean;
}

/** Pull the JSON array out of wrangler stdout (it may prepend banners/warnings). */
function parseWranglerJson(stdout: string): WranglerResult[] {
  const trimmed = stdout.trim();
  const candidates = [trimmed];
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (Array.isArray(parsed)) return parsed as WranglerResult[];
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`remote-d1: could not parse wrangler --json output:\n${stdout.slice(0, 2000)}`);
}

/**
 * Read-only D1 against a NAMED remote database (e.g. "dub-core", "dub-core-staging").
 * Credentials come from the environment (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID).
 */
export function remoteD1(databaseName: string, options: RemoteD1Options = {}): D1Database {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(databaseName)) {
    throw new Error(`remote-d1: suspicious database name "${databaseName}"`);
  }
  const binParts = (options.wranglerBin ?? process.env.WRANGLER_BIN ?? "wrangler").trim().split(/\s+/);
  const cmd = binParts[0]!;
  const leadingArgs = binParts.slice(1);
  const cwd = options.cwd ?? tmpdir();
  const timeout = options.timeoutMs ?? 120_000;

  function query(sql: string): unknown[] {
    assertReadOnlySql(sql);
    const args = [...leadingArgs, "d1", "execute", databaseName, "--remote", "--json", "--command", sql];
    const proc = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    });
    if (proc.error) throw new Error(`remote-d1: failed to run ${cmd}: ${proc.error.message}`);
    if (proc.status !== 0) {
      throw new Error(`remote-d1: wrangler exited ${proc.status}\n${proc.stderr ?? ""}\n${proc.stdout ?? ""}`.trim());
    }
    const blocks = parseWranglerJson(proc.stdout ?? "");
    return blocks[0]?.results ?? [];
  }

  const adapter = {
    prepare(sql: string) {
      assertReadOnlySql(sql); // fail before any process is spawned
      let args: unknown[] = [];
      const api = {
        bind(...b: unknown[]) {
          args = b;
          return api;
        },
        first<T>(): T | null {
          return (query(inlineBinds(sql, args))[0] ?? null) as T | null;
        },
        all<T>() {
          return { results: query(inlineBinds(sql, args)) as T[], success: true, meta: {} };
        },
        run() {
          // Reachable only for SELECT/PRAGMA (the guard above), so this is still a read.
          query(inlineBinds(sql, args));
          return { success: true, meta: { changes: 0, last_row_id: 0, duration: 0 } };
        },
        raw<T>() {
          return query(inlineBinds(sql, args)).map((row) => Object.values(row as object)) as T[];
        },
      };
      return api;
    },
    exec(sql: string): never {
      throw new RemoteD1ReadOnlyError(`exec() is the DDL path: ${sqlStatementList(sql)[0]?.slice(0, 48) ?? ""}`);
    },
    batch(stmts: Array<{ all: () => unknown }>) {
      return stmts.map((s) => s.all());
    },
    dump(): never {
      throw new RemoteD1ReadOnlyError("dump() is not supported");
    },
  } as unknown as D1Database;

  return adapter;
}
