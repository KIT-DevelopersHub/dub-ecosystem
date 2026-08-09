// Namespace-scoped D1 client. Turns the boundary discipline ("only touch your own
// namespace") from a convention into a mechanism. Runtime DDL is forbidden (raw() only).
import type { D1Database } from "@cloudflare/workers-types";
import { DubError } from "@dub/errors";
import { type Namespace, namespaceOf, tablesOf } from "./namespaces";

export type Enforcement = "strict" | "warn" | "off";

export interface DbClientOptions {
  namespace: Namespace;
  requestId?: string; // propagated into log entries
  logger?: (e: DbLogEntry) => void;
  enforcement?: Enforcement; // default "strict"; applies to reads AND writes
}

export interface DbLogEntry {
  sql: string;
  durationMs: number;
  rowsRead?: number;
  rowsWritten?: number;
  requestId?: string;
  namespace: Namespace;
}

export interface DbRunResult {
  success: boolean;
  meta: { changes: number; lastRowId?: number; durationMs: number };
}

export interface DbStatement {
  sql: string;
  binds?: readonly unknown[];
}

export interface DbClient {
  readonly namespace: Namespace;
  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null>;
  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]>;
  run(sql: string, ...binds: unknown[]): Promise<DbRunResult>;
  batch(stmts: readonly DbStatement[]): Promise<DbRunResult[]>;
  raw(): D1Database; // escape hatch; #27 lint:boundaries detects call sites
}

const DDL_REGEX = /^\s*(create|alter|drop|truncate|attach|detach|pragma|reindex|vacuum)\b/i;

function assertNotDdl(sql: string): void {
  if (DDL_REGEX.test(sql)) {
    throw new DubError("DB_FORBIDDEN_STATEMENT", "Runtime DDL is forbidden via DbClient (use raw() with a log mark)", {
      status: 500,
    });
  }
}

function assertNamespace(sql: string, ns: Namespace, enforcement: Enforcement, log?: (msg: string) => void): void {
  if (enforcement === "off") return;
  for (const table of tablesOf(sql)) {
    const owner = namespaceOf(table);
    if (owner !== ns) {
      const msg = `statement touches "${table}" (namespace ${owner ?? "unknown"}) outside declared namespace "${ns}"`;
      if (enforcement === "warn") {
        log?.(msg);
        continue;
      }
      throw new DubError("DB_NAMESPACE_VIOLATION", msg, { status: 500 });
    }
  }
}

export function createDbClient(d1: D1Database, opts: DbClientOptions): DbClient {
  const enforcement: Enforcement = opts.enforcement ?? "strict";
  const ns = opts.namespace;

  const log = (sql: string, durationMs: number, extra?: Partial<DbLogEntry>): void => {
    opts.logger?.({ sql, durationMs, namespace: ns, requestId: opts.requestId, ...extra });
  };

  const guard = (sql: string): void => {
    assertNotDdl(sql);
    assertNamespace(sql, ns, enforcement, (m) => log(sql, 0, { sql: `[warn] ${m}` }));
  };

  const wrapQuery = async <R>(sql: string, fn: () => Promise<R>): Promise<R> => {
    const started = Date.now();
    try {
      const out = await fn();
      log(sql, Date.now() - started);
      return out;
    } catch (cause) {
      throw new DubError("DB_QUERY_FAILED", `D1 query failed: ${digest(sql)}`, { status: 500, cause });
    }
  };

  return {
    namespace: ns,
    async first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
      guard(sql);
      return wrapQuery(sql, async () => (await d1.prepare(sql).bind(...binds).first<T>()) ?? null);
    },
    async all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
      guard(sql);
      return wrapQuery(sql, async () => {
        const res = await d1.prepare(sql).bind(...binds).all<T>();
        return res.results ?? [];
      });
    },
    async run(sql: string, ...binds: unknown[]): Promise<DbRunResult> {
      guard(sql);
      return wrapQuery(sql, async () => {
        const started = Date.now();
        const res = await d1.prepare(sql).bind(...binds).run();
        return {
          success: res.success ?? true,
          meta: { changes: res.meta?.changes ?? 0, lastRowId: res.meta?.last_row_id, durationMs: Date.now() - started },
        };
      });
    },
    async batch(stmts: readonly DbStatement[]): Promise<DbRunResult[]> {
      for (const s of stmts) guard(s.sql);
      return wrapQuery("[batch]", async () => {
        const prepared = stmts.map((s) => d1.prepare(s.sql).bind(...(s.binds ?? [])));
        const results = await d1.batch(prepared);
        return results.map((r) => ({
          success: r.success ?? true,
          meta: { changes: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id, durationMs: r.meta?.duration ?? 0 },
        }));
      });
    },
    raw(): D1Database {
      log("[raw() escape hatch]", 0);
      return d1;
    },
  };
}

function digest(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 80);
}
