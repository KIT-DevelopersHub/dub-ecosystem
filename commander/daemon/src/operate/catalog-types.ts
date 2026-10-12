// Types of the operate allow-list. Kept apart from catalog.ts so the per-area files under
// areas/ can import them without an import cycle.

export type OpArea = "event" | "task" | "gantt" | "notification" | "chat" | "member" | "role" | "drive" | "lp";
export type OpKind = "read" | "write" | "delete";
export type OpRisk = "low" | "mid" | "high";
export type OpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** "$params.x" / "$body.x" pull from the executed call; "$notNull" asserts presence. */
export type VerifyValue = string | number | boolean | null;

export interface VerifySpec {
  /** Catalog id of the read that re-fetches the target after the write. */
  read: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  /** Array field of the read response holding the target (lists without a GET-by-id). */
  findIn?: string;
  /** [field, source] that identifies the target inside `findIn`. */
  findBy?: [string, string];
  /** Every body key except these must read back unchanged. */
  expectBody?: { except: string[] };
  expect?: Record<string, VerifyValue>;
}

export interface CatalogEntry {
  id: string;
  area: OpArea;
  method: OpMethod;
  /** Gateway path under API_PREFIX (= the policy-table key); `:name` = path param. */
  path: string;
  /** Owning service directory (services/<service>/src/policy-table.ts). */
  service: string;
  /** What the policy table demands (fine keys + ロール管理 3-tier). */
  requires: { keys: readonly string[]; appLevel?: { app: string; level: "view" | "edit" } };
  kind: OpKind;
  /** Can the effect be undone through the catalog itself. */
  reversible: boolean;
  risk: OpRisk;
  /** Japanese one-liner for the operator (approval screen) and the planner. */
  description: string;
  /** Planner-only usage note (response fields, preconditions); never shown to the operator. */
  hint?: string;
  /** Japanese impact sentence; `{count}` = number of targets. */
  impact: string;
  query?: string[];
  body?: { allowed: string[]; required: string[] };
  /** Japanese labels for body fields (approval preview). */
  fieldLabels?: Record<string, string>;
  /** Read-back after the write. Every write has this or `unverifiable`. */
  verify?: VerifySpec;
  /** Why no catalog read can confirm this write (Japanese; shown on the approval screen). */
  unverifiable?: string;
  /** Values that must never be targeted (e.g. the owner's role): checked before approval. */
  deny?: DenyRule[];
}

/** Blocks a call whose resolved `field` ("params.id" / "body.roleId") is in a protected set. */
export interface DenyRule {
  field: string;
  set: "roles" | "users";
  /** Japanese reason shown as the blocker. */
  reason: string;
}

/** A route in scope that is deliberately NOT callable, with the reason. */
export interface ExcludedRoute {
  service: string;
  /** "METHOD /path" exactly as in the policy table. */
  route: string;
  reason: string;
}

export interface AreaSpec {
  area: OpArea;
  entries: CatalogEntry[];
  excluded: ExcludedRoute[];
  /** In-scope writes not opened yet (the area's follow-up PR moves them). */
  pending: { service: string; route: string }[];
  /** Irreversible entries the owner opened on purpose: entry id -> why it is acceptable. */
  ownerOpenedIrreversible?: Record<string, string>;
}
