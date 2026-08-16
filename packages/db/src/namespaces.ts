// Schema namespace registry — the source of truth (D11, 19 entries).
// infra #28's NAMESPACE_REGISTRY imports the `Namespace` type from here (no dup list).

export const NAMESPACES = [
  "dub", // @dub/db meta (migration ledger)
  "identity", // identity-roster
  "event", // event-service
  "task", // task-service
  "gantt", // gantt-service (view states)
  "notif", // notification
  "chat", // chat-service (draft; frozen after 9-C)
  "mail", // mail-gateway
  "mailauto", // mail-automation
  "file_meta", // file-meta (longest-prefix match)
  "github", // github-sync
  "webhook", // webhook-ingest
  "deploy", // deploy-service
  "audit", // audit-log
  "mobile", // mobile-bff (MO3)
  "seed", // infra-d1-seed (#28)
  "usage", // usage-meter (free-tier usage snapshots + billing guard)
  "member", // member-service (運営メンバー管理: invite status + team membership)
  "driveshare", // drive-share-service (role-based Google Drive grants + fan-out ledger)
] as const;

export type Namespace = (typeof NAMESPACES)[number];

const NAMESPACE_SET: ReadonlySet<string> = new Set(NAMESPACES);

/** Resolve a table's owning namespace via longest-prefix match (e.g. "file_meta_files" -> "file_meta"). */
export function namespaceOf(table: string): Namespace | null {
  const lower = table.toLowerCase();
  let best: Namespace | null = null;
  for (const ns of NAMESPACES) {
    if (lower === ns || lower.startsWith(ns + "_")) {
      if (best === null || ns.length > best.length) best = ns;
    }
  }
  return best;
}

export function isTableInNamespace(table: string, ns: Namespace): boolean {
  return namespaceOf(table) === ns;
}

export function isKnownNamespace(ns: string): ns is Namespace {
  return NAMESPACE_SET.has(ns);
}

const TABLE_REGEX =
  /\b(?:from|join|into|update|table(?:\s+if\s+not\s+exists)?|delete\s+from)\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi;

// SQL keywords that can legitimately trail one of the clause keywords above WITHOUT
// naming a table — so the regex captures them by mistake. The real case is the
// `... ON CONFLICT(...) DO UPDATE SET` upsert form: "SET" trails "UPDATE" with no table
// between them, and `namespaceOf("SET")` is null, which used to raise a spurious
// DB_NAMESPACE_VIOLATION for every upsert. None of these are ever a real (namespaced)
// table name in this codebase, so dropping them can't hide a genuine violation.
const NON_TABLE_TOKENS: ReadonlySet<string> = new Set(["set", "select", "values", "where"]);

/** Best-effort parse of tables touched by a SQL string (JOINs, subqueries, quoted ids). */
export function tablesOf(sql: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  TABLE_REGEX.lastIndex = 0;
  while ((m = TABLE_REGEX.exec(sql)) !== null) {
    const t = m[1];
    if (t && !NON_TABLE_TOKENS.has(t.toLowerCase())) found.add(t);
  }
  return [...found];
}
