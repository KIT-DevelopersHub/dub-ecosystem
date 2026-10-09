// The operate console's allow-list. "Dubを操作" may ONLY call a route listed here: the
// executor looks every planned call up by catalog id and refuses anything else, so the
// planner can never reach a route nobody reviewed. Each entry mirrors a line of the owning
// service's policy-table.ts (test/operate-catalog.test.ts keeps the two in lock-step) and
// adds the operator-facing metadata the approval screen shows.
//
// Deliberately absent: physical deletes (DELETE issued-addresses, DELETE events) and bulk
// endpoints (publish-batch / unpublish-batch). Fan-out happens one call per target in the
// executor, under its per-execution cap, so every target is listed and verified.

export type OpArea = "event" | "mail" | "notification";
export type OpKind = "read" | "write" | "delete";
export type OpRisk = "low" | "mid" | "high";

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
  method: "GET" | "POST" | "PATCH" | "PUT";
  /** Gateway path under API_PREFIX (= the policy-table key); `:name` = path param. */
  path: string;
  /** Owning service directory (services/<service>/src/policy-table.ts). */
  service: string;
  /** What the policy table demands (fine keys + ロール管理 3-tier). */
  requires: { keys: string[]; appLevel?: { app: string; level: "view" | "edit" } };
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
  verify?: VerifySpec;
}

export const API_PREFIX = "/api/v1";

export const CATALOG: readonly CatalogEntry[] = [
  // ---- イベント編集 (event-service) ----
  {
    id: "events.list",
    area: "event",
    method: "GET",
    path: "/events",
    service: "event-service",
    requires: { keys: ["event:read"], appLevel: { app: "events", level: "view" } },
    kind: "read",
    reversible: true,
    risk: "low",
    description: "イベントの一覧を取得する",
    hint: "items[].id・title・phase・startsAt",
    impact: "読み取りのみ。データは変わりません。",
    query: ["limit", "cursor", "phase", "sort", "includeArchived"],
  },
  {
    id: "events.get",
    area: "event",
    method: "GET",
    path: "/events/:id",
    service: "event-service",
    requires: { keys: ["event:read"], appLevel: { app: "events", level: "view" } },
    kind: "read",
    reversible: true,
    risk: "low",
    description: "イベント1件の詳細を取得する",
    hint: "description・version を含む。更新前に必ずこれで version を読む",
    impact: "読み取りのみ。データは変わりません。",
  },
  {
    id: "events.update",
    area: "event",
    method: "PATCH",
    path: "/events/:id",
    service: "event-service",
    requires: { keys: ["event:write"], appLevel: { app: "events", level: "edit" } },
    kind: "write",
    reversible: true,
    risk: "mid",
    description: "イベントのタイトル・概要・日時を更新する",
    hint: "body.version は直前に events.get で読んだ値。description が概要",
    impact: "{count}件のイベントの表示内容が書き換わり、メンバー全員の画面に反映されます。変更前の値で再更新すれば元に戻せます。",
    body: { allowed: ["title", "description", "startsAt", "endsAt", "version"], required: ["version"] },
    fieldLabels: { title: "タイトル", description: "概要", startsAt: "開始日時", endsAt: "終了日時" },
    verify: { read: "events.get", params: { id: "$params.id" }, expectBody: { except: ["version"] } },
  },

  // ---- メール発行 (identity-roster + mail-gateway) ----
  {
    id: "users.list",
    area: "mail",
    method: "GET",
    path: "/identity/users",
    service: "identity-roster",
    requires: { keys: ["identity:read"] },
    kind: "read",
    reversible: true,
    risk: "low",
    description: "メンバー名簿を取得する",
    hint: "items[].id・displayName・email・status",
    impact: "読み取りのみ。データは変わりません。",
    query: ["status", "q", "limit", "cursor"],
  },
  {
    id: "mail.issued.list",
    area: "mail",
    method: "GET",
    path: "/mail/admin/email-routing/issued-addresses",
    service: "mail-gateway",
    requires: { keys: ["mail:admin"] },
    kind: "read",
    reversible: true,
    risk: "low",
    description: "発行済みの受信アドレス一覧を取得する",
    hint: "items[].id・localPart・address（@developershub.jp）・enabled",
    impact: "読み取りのみ。データは変わりません。",
  },
  {
    id: "mail.issued.create",
    area: "mail",
    method: "POST",
    path: "/mail/admin/email-routing/issued-addresses",
    service: "mail-gateway",
    requires: { keys: ["mail:admin"] },
    kind: "write",
    reversible: false,
    risk: "mid",
    description: "受信アドレス（@developershub.jp）を発行する",
    hint: "body.localPart は @ より前。1件ずつ。発行済みなら409",
    impact: "{count}件のアドレスが受信できるようになり、各アドレスに確認メールが1通届きます。送った確認メールは取り消せません（受信は後から停止できます）。",
    body: { allowed: ["localPart"], required: ["localPart"] },
    fieldLabels: { localPart: "アドレス" },
    verify: {
      read: "mail.issued.list",
      findIn: "items",
      findBy: ["localPart", "$body.localPart"],
      expect: { enabled: true },
    },
  },
  {
    id: "mail.issued.setEnabled",
    area: "mail",
    method: "PATCH",
    path: "/mail/admin/email-routing/issued-addresses/:id",
    service: "mail-gateway",
    requires: { keys: ["mail:admin"] },
    kind: "write",
    reversible: true,
    risk: "mid",
    description: "発行済みアドレスの受信を停止／再開する",
    hint: "body.enabled=false で停止、true で再開。params.id は mail.issued.list の items[].id",
    impact: "{count}件のアドレスの受信可否が切り替わります。もう一度切り替えれば元に戻せます。",
    body: { allowed: ["enabled"], required: ["enabled"] },
    fieldLabels: { enabled: "受信" },
    verify: {
      read: "mail.issued.list",
      findIn: "items",
      findBy: ["id", "$params.id"],
      expect: { enabled: "$body.enabled" },
    },
  },

  // ---- 通知 (notification: 管理者通知のメンバー公開) ----
  {
    id: "notifications.manage.list",
    area: "notification",
    method: "GET",
    path: "/notifications/manage",
    service: "notification",
    requires: { keys: ["notif:broadcast_publish"], appLevel: { app: "notifications", level: "view" } },
    kind: "read",
    reversible: true,
    risk: "low",
    description: "管理者通知の一覧を取得する",
    hint: "items[].id・title・publishedBroadcastId（非nullならメンバーに公開中）",
    impact: "読み取りのみ。データは変わりません。",
    query: ["limit", "cursor"],
  },
  {
    id: "notifications.unpublish",
    area: "notification",
    method: "POST",
    path: "/notifications/manage/:id/unpublish",
    service: "notification",
    requires: { keys: ["notif:broadcast_publish"], appLevel: { app: "notifications", level: "edit" } },
    kind: "delete",
    reversible: true,
    risk: "high",
    description: "通知を削除する（メンバー全員の受信箱から取り下げる）",
    hint: "管理者側の元の通知は残る。公開中のもの（publishedBroadcastId 非null）が対象",
    impact: "{count}件の通知がメンバー全員の受信箱から消えます。再公開で戻せますが、各メンバーの既読状態は失われます。",
    verify: {
      read: "notifications.manage.list",
      query: { limit: "200" },
      findIn: "items",
      findBy: ["id", "$params.id"],
      expect: { publishedBroadcastId: null },
    },
  },
  {
    id: "notifications.publish",
    area: "notification",
    method: "POST",
    path: "/notifications/manage/:id/publish",
    service: "notification",
    requires: { keys: ["notif:broadcast_publish"], appLevel: { app: "notifications", level: "edit" } },
    kind: "write",
    reversible: true,
    risk: "mid",
    description: "管理者通知をメンバー全員に公開する",
    impact: "{count}件の通知がメンバー全員の受信箱に届きます。取り下げれば消せます。",
    verify: {
      read: "notifications.manage.list",
      query: { limit: "200" },
      findIn: "items",
      findBy: ["id", "$params.id"],
      expect: { publishedBroadcastId: "$notNull" },
    },
  },
];

export function findEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

/** Path param names in declaration order (":id" -> "id"). */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
}

/** The keys a bot role needs to reach every catalog entry (excluding ロール管理 tiers). */
export function requiredPermissionKeys(): string[] {
  return [...new Set(CATALOG.flatMap((e) => e.requires.keys))].sort();
}
