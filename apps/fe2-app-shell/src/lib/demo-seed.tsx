// Demo transport for the composed shell (backend-free showcase build).
//
// The offline `createMockFetch` (mock-api-client.tsx) only answers the shell BOOT
// surface (/me, /bff/home, /auth/*); every feature route falls through to a 404
// envelope so screens show their in-frame fallback. That is right for CI smoke,
// but a *demo* build wants the feature screens populated: navigate to メール /
// イベント / タスク / 通知 / 名簿 and see representative data.
//
// This module layers a richer, read-mostly seed on top of the same MSW-style
// transport swap. It:
//   1. auto-completes login — the demo `/me` returns a broad-permission session,
//      so RequireAuth passes without any OAuth round-trip;
//   2. answers each feature's primary list endpoint (events / tasks / gantt /
//      notifications / mail / identity) from in-memory seed data;
//   3. answers the common detail + benign mutation endpoints (mail thread/read,
//      event detail/actions, notification read) so clicking a row still works.
//
// It is a MOCK: no real gateway, no real data, no real mail is ever sent. Only
// the transport is swapped; the real api-client (session/refresh/requestId/retry/
// error-normalization) runs unchanged over it. Unhandled routes delegate to the
// boot mock and surface as a normal NOT_FOUND (in-frame fallback, never a white
// screen), so "what is seeded vs. still stubbed" stays honest.
import type { ErrorResponse } from "@dub/errors";
import type { auditLog, event, gantt, gateway, identity, mail, notification, task } from "@dub/types";
// Value import (namespace) for the frozen RBAC catalog served to the admin screen.
import { identity as identityValues } from "@dub/types";
import { createMockFetch } from "./mock-api-client.tsx";

const ORG = "org_demo";
const ME_ID = "usr_demo";

// Broad permission set: every primary nav item + its detail screens render.
// Demo-only — the real gateway is authoritative; this just unlocks the UI.
const DEMO_PERMISSIONS: identity.PermissionKey[] = [
  "identity:read",
  "identity:admin",
  "event:read",
  "event:write",
  "event:admin",
  "task:read",
  "task:write",
  "task:delete",
  "file:read",
  "notif:inbox:self",
  "notif:prefs:self",
  "mail:read",
  "mail:send",
  "mail:admin",
  "chat:create",
  "audit:read",
];

const DEMO_ME: gateway.MeResponse = {
  user: { id: ME_ID, displayName: "デモ 管理者", avatarUrl: null },
  orgId: ORG,
  permissions: DEMO_PERMISSIONS,
  sessionExpiresAt: Date.now() + 60 * 60 * 1000,
};

// ── events ────────────────────────────────────────────────────────────────────
const EVENTS: event.EventSummary[] = [
  { id: "evt_1", title: "北陸ITカンファレンス 2026", phase: "preparing", startsAt: "2026-08-05T01:00:00Z" },
  { id: "evt_2", title: "運営定例ミーティング", phase: "planning", startsAt: "2026-08-12T09:00:00Z" },
  { id: "evt_3", title: "学生ハッカソン Hackit 秋", phase: "open", startsAt: "2026-09-01T00:00:00Z" },
];

const EVENT_DETAIL: Record<string, event.EventDetail> = {
  evt_1: {
    version: 3,
    id: "evt_1",
    orgId: ORG,
    title: "北陸ITカンファレンス 2026",
    description: "北陸最大級の技術カンファレンス。会場運営・登壇者調整・広報を横断で進行中。",
    phase: "preparing",
    startsAt: "2026-08-05T01:00:00Z",
    endsAt: "2026-08-05T09:00:00Z",
    archivedAt: null,
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    actions: [
      { id: "act_1", eventId: "evt_1", kind: "task_management", title: "会場設営タスク" },
      { id: "act_2", eventId: "evt_1", kind: "announcement", title: "参加者への案内メール" },
    ],
  },
};

const EVENT_ACTIONS: Record<string, event.DubAction[]> = {
  evt_1: [
    {
      version: 1,
      id: "act_1",
      eventId: "evt_1",
      kind: "task_management",
      title: "会場設営タスク",
      sortOrder: 0,
      archivedAt: null,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    },
    {
      version: 1,
      id: "act_2",
      eventId: "evt_1",
      kind: "announcement",
      title: "参加者への案内メール",
      sortOrder: 1,
      archivedAt: null,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    },
  ],
};

// ── tasks ───────────────────────────────────────────────────────────────────
const TASKS: task.Task[] = [
  {
    version: 2, id: "tsk_1", eventId: "evt_1", title: "登壇者スケジュール確定", description: "全12セッションの時間割を確定する",
    status: "in_progress", priority: "high", assigneeId: ME_ID, dueAt: "2026-08-03T09:00:00Z", origin: "internal",
    archivedAt: null, createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
  },
  {
    version: 1, id: "tsk_2", eventId: "evt_1", title: "会場レイアウト図作成", description: null,
    status: "todo", priority: "medium", assigneeId: ME_ID, dueAt: "2026-08-04T09:00:00Z", origin: "internal",
    archivedAt: null, createdAt: "2026-07-05T00:00:00Z", updatedAt: "2026-07-20T00:00:00Z",
  },
  {
    version: 1, id: "tsk_3", eventId: "evt_1", title: "スポンサー請求書送付", description: "確定した3社へ請求",
    status: "done", priority: "urgent", assigneeId: "usr_bob", dueAt: "2026-07-25T09:00:00Z", origin: "internal",
    archivedAt: null, createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-24T00:00:00Z",
  },
  {
    version: 1, id: "tsk_4", eventId: "evt_1", title: "受付システム連携確認", description: null,
    status: "blocked", priority: "medium", assigneeId: null, dueAt: null, origin: "github",
    archivedAt: null, createdAt: "2026-07-10T00:00:00Z", updatedAt: "2026-07-28T00:00:00Z",
  },
];

const GANTT: Record<string, gantt.GanttChartDTO> = {
  evt_1: {
    eventId: "evt_1",
    rows: [
      { taskId: "tsk_1", title: "登壇者スケジュール確定", startsAt: "2026-07-28T00:00:00Z", endsAt: "2026-08-03T00:00:00Z", progressPercent: 40, assigneeId: ME_ID },
      { taskId: "tsk_2", title: "会場レイアウト図作成", startsAt: "2026-07-30T00:00:00Z", endsAt: "2026-08-04T00:00:00Z", progressPercent: 0, assigneeId: ME_ID },
      { taskId: "tsk_3", title: "スポンサー請求書送付", startsAt: "2026-07-20T00:00:00Z", endsAt: "2026-07-25T00:00:00Z", progressPercent: 100, assigneeId: "usr_bob" },
      { taskId: "tsk_4", title: "受付システム連携確認", startsAt: "2026-07-25T00:00:00Z", endsAt: "2026-08-02T00:00:00Z", progressPercent: 0, assigneeId: null },
    ],
    dependencies: [
      { id: "tsk_2->tsk_1", fromTaskId: "tsk_1", toTaskId: "tsk_2", type: "FS", lagDays: 0 },
    ],
  },
};

// ── notifications ─────────────────────────────────────────────────────────────
const NOTIFICATIONS: notification.InboxItem[] = [
  { id: "ntf_1", type: "task.assigned", title: "タスクが割り当てられました", body: "「登壇者スケジュール確定」があなたに割り当てられました。", readAt: null, createdAt: "2026-08-02T02:00:00Z", resourceType: "task", resourceId: "tsk_1" },
  { id: "ntf_2", type: "mail.received", title: "新着メール", body: "山田 花子さんからメールが届いています。", readAt: null, createdAt: "2026-08-02T01:00:00Z", resourceType: "mail", resourceId: "msg_1" },
  { id: "ntf_3", type: "event.phase_changed", title: "イベントのフェーズが変更されました", body: "「北陸ITカンファレンス 2026」が preparing になりました。", readAt: "2026-08-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z", resourceType: "event", resourceId: "evt_1" },
];

// ── mail ────────────────────────────────────────────────────────────────────
const MAIL_LIST: mail.MailMessageListItem[] = [
  {
    id: "msg_1", messageId: "<m1@demo>", threadId: "thr_1", from: { email: "hanako@example.com", name: "山田 花子" },
    to: [{ email: "demo@developershub.jp" }], subject: "登壇のご相談", snippet: "カンファレンスでの登壇について相談させてください。",
    receivedAt: "2026-08-02T01:30:00Z", read: false,
  },
  {
    id: "msg_2", messageId: "<m2@demo>", threadId: "thr_2", from: { email: "sponsor@acme.co.jp", name: "ACME株式会社" },
    to: [{ email: "demo@developershub.jp" }], subject: "スポンサー契約書の送付", snippet: "契約書を添付いたします。ご確認ください。",
    receivedAt: "2026-08-01T05:00:00Z", read: false,
  },
  {
    id: "msg_3", messageId: "<m3@demo>", threadId: "thr_3", from: { email: "staff@developershub.jp", name: "運営スタッフ" },
    to: [{ email: "demo@developershub.jp" }], subject: "会場下見の日程", snippet: "来週の下見日程を共有します。",
    receivedAt: "2026-07-30T08:00:00Z", read: true,
  },
];

const MAIL_DETAIL: Record<string, mail.MailMessageDetail> = {
  msg_1: { ...MAIL_LIST[0]!, textBody: "お世話になっております。山田です。\n\nカンファレンスでの登壇について相談させてください。テーマは『Cloudflare Workers 実践』を考えています。\n\nよろしくお願いいたします。" },
  msg_2: { ...MAIL_LIST[1]!, textBody: "ACME株式会社の佐藤です。\n\nスポンサー契約書を送付いたします。ご確認のうえ、ご署名をお願いいたします。" },
  msg_3: { ...MAIL_LIST[2]!, textBody: "運営スタッフです。来週火曜 14:00 から会場下見を予定しています。ご都合いかがでしょうか。" },
};

const MAIL_THREAD: Record<string, mail.MailThread> = {
  thr_1: { id: "thr_1", messages: [MAIL_DETAIL.msg_1!] },
  thr_2: { id: "thr_2", messages: [MAIL_DETAIL.msg_2!] },
  thr_3: { id: "thr_3", messages: [MAIL_DETAIL.msg_3!] },
};

// ── mail: stateful Inbox + Sent folders ───────────────────────────────────────
// A tiny in-session store so the mail folders behave end-to-end: received messages
// persist their read flag (opening one clears the unread badge on refetch), and a
// demo "send" is observable in the Sent folder (POST /mail/outbox → GET /mail/sent →
// GET /mail/sent/:id). Fresh per createDemoFetch() → a reload resets. No real mail
// leaves the browser (the demo banner says so).
function firstLine(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) : oneLine;
}

function createMailStore() {
  // Received seed = the same clean sample set the demo already shows (msg_1..3), cloned
  // so the read flag can be flipped in-session without mutating the module constants.
  const received: mail.MailMessageDetail[] = Object.values(MAIL_DETAIL).map((m) => ({ ...m }));
  const sent: mail.MailSentDetail[] = [];
  let seq = 0;

  function handle(method: string, pathname: string, _url: URL, body: unknown): Response | null {
    // received: list / detail / mark-read (read state persists in-session)
    if (method === "GET" && pathname === "/api/v1/mail/messages") {
      const items: mail.MailMessageListItem[] = received.map(({ textBody, htmlBody, ...li }) => {
        void textBody;
        void htmlBody;
        return li;
      });
      return json(page(items));
    }
    {
      const m = /^\/api\/v1\/mail\/messages\/([^/]+)$/.exec(pathname);
      if (m && method === "GET") {
        const found = received.find((r) => r.id === decodeURIComponent(m[1]!));
        return found ? json(found) : notFound(`GET ${pathname}`);
      }
    }
    if (method === "POST") {
      const m = /^\/api\/v1\/mail\/messages\/([^/]+)\/read$/.exec(pathname);
      if (m) {
        const found = received.find((r) => r.id === decodeURIComponent(m[1]!));
        if (found) found.read = true;
        return json({ read: true });
      }
    }
    // sent: outbox append + list + detail
    if (method === "POST" && pathname === "/api/v1/mail/outbox") {
      const req = (body ?? {}) as Partial<mail.SendMailRequest>;
      const id = `sent_demo_${Date.now().toString(36)}_${seq++}`;
      const sentAt = new Date().toISOString();
      const providerMessageId = `<demo-${Date.now()}@developershub.jp>`;
      const detail: mail.MailSentDetail = {
        id,
        from: { email: "demo@developershub.jp", name: "デモ 管理者" },
        to: req.to ?? [],
        ...(req.cc && req.cc.length > 0 ? { cc: req.cc } : {}),
        subject: req.subject ?? "(件名なし)",
        snippet: firstLine(req.textBody ?? ""),
        sentAt,
        provider: "resend",
        providerMessageId,
        status: "sent",
        textBody: req.textBody ?? "",
        ...(req.htmlBody ? { htmlBody: req.htmlBody } : {}),
      };
      sent.unshift(detail);
      const res: mail.SendMailResponse = { messageId: providerMessageId, provider: "resend", acceptedAt: sentAt };
      return json(res);
    }
    if (method === "GET" && pathname === "/api/v1/mail/sent") {
      const items: mail.MailSentListItem[] = sent.map(({ textBody, htmlBody, ...listItem }) => {
        void textBody;
        void htmlBody;
        return listItem;
      });
      return json(page(items));
    }
    if (method === "GET") {
      const m = /^\/api\/v1\/mail\/sent\/([^/]+)$/.exec(pathname);
      if (m) {
        const found = sent.find((s) => s.id === decodeURIComponent(m[1]!));
        return found ? json(found) : notFound(`GET ${pathname}`);
      }
    }
    return null;
  }

  return { handle };
}

// ── identity / roster (admin RBAC console) ────────────────────────────────────
// The admin console (FE7 @dub/admin-roster) is fully INTERACTIVE in the demo:
// permission-matrix edit, role add and user role assignment all persist in an
// in-session store (createRosterStore), so a viewer can toggle a role's
// permissions and save, create a new role, and assign it to a user end-to-end.
// Nothing leaves the browser. Roles are the 3 agreed tiers admin / maintainer /
// member (system, read-only) plus any custom role the viewer creates.
function isoNow(): string {
  return "2026-08-01T00:00:00Z";
}

// maintainer: broad operational write across the product, but NOT identity admin
// (cannot manage roles/users) — the middle tier between admin and member.
const MAINTAINER_PERMISSIONS: identity.PermissionKey[] = [
  "identity:read",
  "event:read",
  "event:write",
  "event:admin",
  "task:read",
  "task:write",
  "task:delete",
  "file:read",
  "file:write",
  "mail:read",
  "mail:send",
  "mail:admin",
  "chat:create",
  "chat:moderate",
  "github:read",
  "notif:send",
];
const MEMBER_PERMISSIONS: identity.PermissionKey[] = ["identity:read", "event:read", "task:read"];

const SEED_USERS: identity.IdentityUser[] = [
  { id: ME_ID, orgId: ORG, displayName: "デモ 管理者", email: "demo@developershub.jp", githubLogin: "demo", avatarUrl: null, status: "active", roleIds: ["role_admin"], createdAt: isoNow(), updatedAt: isoNow() },
  { id: "usr_bob", orgId: ORG, displayName: "佐藤 太郎", email: "taro@developershub.jp", githubLogin: "taro", avatarUrl: null, status: "active", roleIds: ["role_maintainer"], createdAt: isoNow(), updatedAt: isoNow() },
  { id: "usr_carol", orgId: ORG, displayName: "鈴木 一郎", email: "ichiro@developershub.jp", githubLogin: null, avatarUrl: null, status: "active", roleIds: ["role_member"], createdAt: isoNow(), updatedAt: isoNow() },
  { id: "usr_dave", orgId: ORG, displayName: "田中 次郎", email: "jiro@developershub.jp", githubLogin: null, avatarUrl: null, status: "invited", roleIds: [], createdAt: isoNow(), updatedAt: isoNow() },
];

const SEED_ROLES: identity.Role[] = [
  { id: "role_admin", orgId: ORG, name: "admin", permissions: DEMO_PERMISSIONS, isSystem: true },
  { id: "role_maintainer", orgId: ORG, name: "maintainer", permissions: MAINTAINER_PERMISSIONS, isSystem: true },
  { id: "role_member", orgId: ORG, name: "member", permissions: MEMBER_PERMISSIONS, isSystem: true },
];

// FE7's RoleAssignment (contracts/pending) — org-wide (resource fields null) here.
interface DemoRoleAssignment {
  id: string;
  userId: string;
  roleId: string;
  roleName: string;
  resourceType: "event" | null;
  resourceId: string | null;
  grantedBy: string;
  grantedAt: string;
}

const SEED_USER_ROLES: Record<string, DemoRoleAssignment[]> = {
  [ME_ID]: [{ id: "asg_1", userId: ME_ID, roleId: "role_admin", roleName: "admin", resourceType: null, resourceId: null, grantedBy: ME_ID, grantedAt: isoNow() }],
  usr_bob: [{ id: "asg_2", userId: "usr_bob", roleId: "role_maintainer", roleName: "maintainer", resourceType: null, resourceId: null, grantedBy: ME_ID, grantedAt: isoNow() }],
  usr_carol: [{ id: "asg_3", userId: "usr_carol", roleId: "role_member", roleName: "member", resourceType: null, resourceId: null, grantedBy: ME_ID, grantedAt: isoNow() }],
};

// Change-history seed (FE7 変更履歴 tab shows identity.* actions).
const SEED_AUDITS: auditLog.AuditRecord[] = [
  { id: "aud_1", action: "identity.role.assigned", actorId: ME_ID, orgId: ORG, result: "success", resourceType: "user", resourceId: "usr_bob", details: { roleId: "role_maintainer" }, requestId: "req_1", occurredAt: isoNow(), recordedAt: isoNow() },
  { id: "aud_2", action: "identity.role.assigned", actorId: ME_ID, orgId: ORG, result: "success", resourceType: "user", resourceId: "usr_carol", details: { roleId: "role_member" }, requestId: "req_2", occurredAt: isoNow(), recordedAt: isoNow() },
];

// Email Routing (@developershub.jp) seed — managed addresses / forwarding rules.
const EMAIL_DOMAIN = "developershub.jp";
interface DemoEmailAddress {
  id: string;
  localPart: string;
  address: string;
  destination: string;
  enabled: boolean;
  createdAt: string;
}
const SEED_EMAIL_ADDRESSES: DemoEmailAddress[] = [
  { id: "eml_info", localPart: "info", address: `info@${EMAIL_DOMAIN}`, destination: "staff@example.com", enabled: true, createdAt: isoNow() },
  { id: "eml_support", localPart: "support", address: `support@${EMAIL_DOMAIN}`, destination: "help@example.com", enabled: true, createdAt: isoNow() },
  { id: "eml_press", localPart: "press", address: `press@${EMAIL_DOMAIN}`, destination: "pr@example.com", enabled: true, createdAt: isoNow() },
  { id: "eml_noreply", localPart: "noreply", address: `noreply@${EMAIL_DOMAIN}`, destination: "void@example.com", enabled: false, createdAt: isoNow() },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCALPART_RE = /^[a-z0-9._-]+$/;

/** A normalized error envelope so the api-client surfaces a meaningful message. */
function problem(code: string, message: string, status: number, details?: unknown): Response {
  const body: ErrorResponse = { error: { code, message, retryable: false, ...(details !== undefined ? { details } : {}) } };
  return json(body, status);
}

/** In-session, mutable roster store powering the interactive admin console.
 *  A fresh store per createDemoFetch() call → tests get isolated state and a
 *  page reload resets the demo. Mirrors the identity-roster contract surface
 *  (GET/POST/PATCH/DELETE identity/roles + users + assignments, audit, mail). */
function createRosterStore() {
  const roles: identity.Role[] = SEED_ROLES.map((r) => ({ ...r, permissions: [...r.permissions] }));
  const users: identity.IdentityUser[] = SEED_USERS.map((u) => ({ ...u, roleIds: [...u.roleIds] }));
  const assignments: Record<string, DemoRoleAssignment[]> = {};
  for (const [k, v] of Object.entries(SEED_USER_ROLES)) assignments[k] = v.map((a) => ({ ...a }));
  const audits: auditLog.AuditRecord[] = SEED_AUDITS.map((a) => ({ ...a }));
  const emails: DemoEmailAddress[] = SEED_EMAIL_ADDRESSES.map((a) => ({ ...a }));

  const rid = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  const summaries = (): identity.UserSummary[] => users.map((u) => ({ id: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl }));
  const detail = (u: identity.IdentityUser): identity.IdentityUserDetail => ({
    ...u,
    permissions: [...new Set(roles.filter((r) => u.roleIds.includes(r.id)).flatMap((r) => r.permissions))],
  });
  function audit(action: string, resourceType: string, resourceId: string, details: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    audits.unshift({ id: rid("aud"), action, actorId: ME_ID, orgId: ORG, result: "success", resourceType, resourceId, details, requestId: rid("req"), occurredAt: ts, recordedAt: ts });
  }

  function handle(method: string, pathname: string, url: URL, body: unknown): Response | null {
    const seg = (re: RegExp): string | null => {
      const m = re.exec(pathname);
      return m ? decodeURIComponent(m[1]!) : null;
    };

    if (method === "GET") {
      if (pathname === "/api/v1/identity/users") {
        // FE3/FE6 resolve display names via ?ids=; roster lists the full set.
        return json(page(url.searchParams.has("ids") ? summaries() : users));
      }
      {
        const id = seg(/^\/api\/v1\/identity\/users\/([^/]+)\/roles$/);
        if (id) return json(assignments[id] ?? []);
      }
      {
        const id = seg(/^\/api\/v1\/identity\/users\/([^/]+)$/);
        if (id) {
          const u = users.find((x) => x.id === id);
          return u ? json(detail(u)) : problem("NOT_FOUND", "user not found", 404);
        }
      }
      if (pathname === "/api/v1/identity/roles") return json(page(roles));
      if (pathname === "/api/v1/identity/permissions/catalog") return json(identityValues.PERMISSION_CATALOG);
      if (pathname === "/api/v1/audit/logs") {
        const action = url.searchParams.get("action") ?? "identity.";
        return json(page(audits.filter((a) => a.action.startsWith(action))));
      }
      if (pathname === "/api/v1/mail/status") {
        return json({ service: "mail-gateway", provider: "resend", rateLimit: { active: false, cooldownSec: 60 } });
      }
      if (pathname === "/api/v1/mail/admin/email-routing/addresses") return json(page(emails));
      return null;
    }

    if (method === "POST") {
      if (pathname === "/api/v1/identity/roles") {
        const req = body as { name?: string; permissions?: identity.PermissionKey[] };
        if (!req?.name?.trim()) return problem("VALIDATION_FAILED", "ロール名を入力してください", 400, [{ field: "name", reason: "required" }]);
        if (roles.some((r) => r.name === req.name)) return problem("CONFLICT", "同名のロールが既に存在します", 409);
        const role: identity.Role = { id: rid("role"), orgId: ORG, name: req.name.trim(), permissions: req.permissions ?? [], isSystem: false };
        roles.push(role);
        audit("identity.role.created", "role", role.id, { name: role.name, permissions: role.permissions.length });
        return json(role);
      }
      {
        const userId = seg(/^\/api\/v1\/identity\/users\/([^/]+)\/roles$/);
        if (userId) {
          const req = body as { roleId?: string; resourceType?: "event"; resourceId?: string };
          const role = roles.find((r) => r.id === req?.roleId);
          if (!role) return problem("VALIDATION_FAILED", "不明なロールです", 400, [{ field: "roleId", reason: "not_found" }]);
          const list = assignments[userId] ?? (assignments[userId] = []);
          if (list.some((a) => a.roleId === role.id && a.resourceId === (req.resourceId ?? null))) {
            return problem("CONFLICT", "このロールは既に付与されています", 409);
          }
          const asg: DemoRoleAssignment = { id: rid("asg"), userId, roleId: role.id, roleName: role.name, resourceType: req.resourceType ?? null, resourceId: req.resourceId ?? null, grantedBy: ME_ID, grantedAt: new Date().toISOString() };
          list.push(asg);
          const u = users.find((x) => x.id === userId);
          if (u && !u.roleIds.includes(role.id)) u.roleIds.push(role.id);
          audit("identity.role.assigned", "user", userId, { roleId: role.id });
          return json(asg);
        }
      }
      if (pathname === "/api/v1/identity/users/invite") {
        const req = body as { email?: string; displayName?: string; roleIds?: string[] };
        if (!EMAIL_RE.test(req?.email ?? "")) return problem("VALIDATION_FAILED", "メール形式が不正です", 400, [{ field: "email", reason: "format" }]);
        if (users.some((u) => u.email === req.email)) return problem("CONFLICT", "既に登録済みのメールです", 409);
        const user: identity.IdentityUser = { id: rid("usr"), orgId: ORG, displayName: req.displayName ?? req.email!, email: req.email!, githubLogin: null, avatarUrl: null, status: "invited", roleIds: req.roleIds ?? [], createdAt: isoNow(), updatedAt: new Date().toISOString() };
        users.push(user);
        audit("identity.user.provisioned", "user", user.id, { email: user.email });
        return json(user);
      }
      if (pathname === "/api/v1/mail/admin/email-routing/addresses") {
        const req = body as { localPart?: string; destination?: string };
        const localPart = req?.localPart?.trim().toLowerCase() ?? "";
        if (!LOCALPART_RE.test(localPart)) return problem("VALIDATION_FAILED", "ローカル部が不正です（英小文字・数字・.\_- のみ）", 400, [{ field: "localPart", reason: "format" }]);
        if (!EMAIL_RE.test(req?.destination ?? "")) return problem("VALIDATION_FAILED", "転送先のメール形式が不正です", 400, [{ field: "destination", reason: "format" }]);
        if (emails.some((a) => a.localPart === localPart)) return problem("CONFLICT", "同名のアドレスが既に存在します", 409);
        const addr: DemoEmailAddress = { id: rid("eml"), localPart, address: `${localPart}@${EMAIL_DOMAIN}`, destination: req!.destination!, enabled: true, createdAt: new Date().toISOString() };
        emails.push(addr);
        return json(addr);
      }
      return null;
    }

    if (method === "PATCH") {
      {
        const id = seg(/^\/api\/v1\/identity\/roles\/([^/]+)$/);
        if (id) {
          const role = roles.find((r) => r.id === id);
          if (!role) return problem("NOT_FOUND", "role not found", 404);
          if (role.isSystem) return problem("CONFLICT", "システムロールは編集できません", 409);
          const req = body as { name?: string; permissions?: identity.PermissionKey[] };
          if (req?.name !== undefined) role.name = req.name;
          if (req?.permissions !== undefined) role.permissions = req.permissions;
          audit("identity.role.updated", "role", role.id, { permissions: role.permissions.length });
          return json(role);
        }
      }
      {
        const id = seg(/^\/api\/v1\/identity\/users\/([^/]+)$/);
        if (id) {
          const u = users.find((x) => x.id === id);
          if (!u) return problem("NOT_FOUND", "user not found", 404);
          const req = body as Partial<identity.IdentityUser>;
          Object.assign(u, req, { updatedAt: new Date().toISOString() });
          audit("identity.user.updated", "user", u.id, {});
          return json(u);
        }
      }
      {
        const id = seg(/^\/api\/v1\/mail\/admin\/email-routing\/addresses\/([^/]+)$/);
        if (id) {
          const addr = emails.find((a) => a.id === id);
          if (!addr) return problem("NOT_FOUND", "address not found", 404);
          const req = body as { enabled?: boolean; destination?: string };
          if (req?.destination !== undefined) {
            if (!EMAIL_RE.test(req.destination)) return problem("VALIDATION_FAILED", "転送先のメール形式が不正です", 400, [{ field: "destination", reason: "format" }]);
            addr.destination = req.destination;
          }
          if (req?.enabled !== undefined) addr.enabled = req.enabled;
          return json(addr);
        }
      }
      return null;
    }

    if (method === "DELETE") {
      {
        const id = seg(/^\/api\/v1\/identity\/roles\/([^/]+)$/);
        if (id) {
          const role = roles.find((r) => r.id === id);
          if (!role) return problem("NOT_FOUND", "role not found", 404);
          if (role.isSystem) return problem("CONFLICT", "システムロールは削除できません", 409);
          roles.splice(roles.indexOf(role), 1);
          audit("identity.role.deleted", "role", role.id, { name: role.name });
          return json(null, 204);
        }
      }
      {
        const m = /^\/api\/v1\/identity\/users\/([^/]+)\/roles\/([^/]+)$/.exec(pathname);
        if (m) {
          const userId = decodeURIComponent(m[1]!);
          const asgId = decodeURIComponent(m[2]!);
          const list = assignments[userId] ?? [];
          const removed = list.find((a) => a.id === asgId);
          assignments[userId] = list.filter((a) => a.id !== asgId);
          if (removed) {
            const u = users.find((x) => x.id === userId);
            if (u && !(assignments[userId] ?? []).some((a) => a.roleId === removed.roleId)) {
              u.roleIds = u.roleIds.filter((r) => r !== removed.roleId);
            }
            audit("identity.role.revoked", "user", userId, { assignmentId: asgId });
          }
          return json(null, 204);
        }
      }
      {
        const id = seg(/^\/api\/v1\/mail\/admin\/email-routing\/addresses\/([^/]+)$/);
        if (id) {
          const idx = emails.findIndex((a) => a.id === id);
          if (idx >= 0) emails.splice(idx, 1);
          return json(null, 204);
        }
      }
      return null;
    }

    return null;
  }

  return { handle };
}

// ── transport helpers ─────────────────────────────────────────────────────────
function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function notFound(route: string): Response {
  const body: ErrorResponse = { error: { code: "NOT_FOUND", message: `demo: no handler for ${route}`, retryable: false } };
  return json(body, 404);
}
function page<T>(items: T[]): { items: T[]; nextCursor: string | null } {
  return { items, nextCursor: null };
}

/** Match a demo feature route; return a Response or null to fall through to boot. */
function matchDemoRoute(method: string, pathname: string, url: URL): Response | null {
  const seg = (re: RegExp): string | null => {
    const m = re.exec(pathname);
    return m ? decodeURIComponent(m[1]!) : null;
  };

  if (method === "GET") {
    // events
    if (pathname === "/api/v1/events") return json(page(EVENTS));
    {
      const id = seg(/^\/api\/v1\/events\/([^/]+)\/actions$/);
      if (id) return json(page(EVENT_ACTIONS[id] ?? []));
    }
    {
      const id = seg(/^\/api\/v1\/events\/([^/]+)$/);
      if (id) return EVENT_DETAIL[id] ? json(EVENT_DETAIL[id]) : notFound(`GET ${pathname}`);
    }
    // tasks
    if (pathname === "/api/v1/tasks") return json(page(TASKS));
    {
      const id = seg(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (id) {
        const t = TASKS.find((x) => x.id === id);
        return t ? json(t) : notFound(`GET ${pathname}`);
      }
    }
    // gantt
    if (pathname === "/api/v1/gantt") {
      const ev = url.searchParams.get("event") ?? "evt_1";
      return json(GANTT[ev] ?? { eventId: ev, rows: [], dependencies: [] });
    }
    if (pathname === "/api/v1/gantt/dependencies") {
      const ev = url.searchParams.get("event") ?? "evt_1";
      return json(GANTT[ev]?.dependencies ?? []);
    }
    // notifications
    if (pathname === "/api/v1/notifications/inbox") {
      const unreadOnly = url.searchParams.get("unreadOnly") === "true";
      return json(page(unreadOnly ? NOTIFICATIONS.filter((n) => n.readAt === null) : NOTIFICATIONS));
    }
    if (pathname === "/api/v1/notifications/inbox/unread-count") {
      return json({ count: NOTIFICATIONS.filter((n) => n.readAt === null).length });
    }
    // mail: received list / detail + the Sent folder are served by the stateful mail
    // store (createMailStore) so read-state and sends persist in-session; only the
    // static thread view stays here.
    {
      const id = seg(/^\/api\/v1\/mail\/threads\/([^/]+)$/);
      if (id) return MAIL_THREAD[id] ? json(MAIL_THREAD[id]) : notFound(`GET ${pathname}`);
    }
    // identity / roster (users, roles, assignments, catalog, audit, mail-status)
    // are served by the stateful roster store (createRosterStore) so the admin
    // console's mutations persist — see createDemoFetch below.
    // chat: seed empty so the screen renders its empty state (no WS in demo).
    if (pathname === "/api/v1/chat/channels") return json([]);
    if (pathname === "/api/v1/chat/unread") return json([]);
  }

  if (method === "POST") {
    // mail read + send are served by the stateful mail store (createMailStore).
    if (pathname === "/api/v1/notifications/inbox/read-all") return json(null, 204);
  }

  if (method === "PATCH") {
    if (/^\/api\/v1\/notifications\/inbox\/[^/]+\/read$/.test(pathname)) return json(null, 204);
    if (pathname === "/api/v1/notifications/preferences") return json(null, 204);
  }

  return null;
}

/** A `fetch` that serves the demo feature surface, delegating boot + unknown
 *  routes to the offline boot mock. Feed to createApiClient({ fetchImpl }). */
export function createDemoFetch(): typeof fetch {
  const boot = createMockFetch({
    me: DEMO_ME,
    home: {
      upcomingEvents: EVENTS.slice(0, 2),
      unreadCount: NOTIFICATIONS.filter((n) => n.readAt === null).length,
      partialErrors: [],
    },
  });
  // Mutable roster state for the interactive admin console (create/edit/assign).
  const roster = createRosterStore();
  // Mutable Inbox + Sent folders (read-state persists; a demo send lands in Sent).
  const mailStore = createMailStore();

  const demoFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    // Parse the JSON body once for the roster store's mutation handlers.
    let parsedBody: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = undefined;
      }
    }
    const hit =
      roster.handle(method, url.pathname, url, parsedBody) ??
      mailStore.handle(method, url.pathname, url, parsedBody) ??
      matchDemoRoute(method, url.pathname, url);
    if (hit) return hit;
    // Boot surface (/me, /bff/home, /auth/*) + NOT_FOUND for everything else.
    return boot(input, init);
  };

  return demoFetch as unknown as typeof fetch;
}

/** True when the shell should boot the demo transport (VITE_DEMO=1 / true). */
export function isDemoEnabled(env: { VITE_DEMO?: string } | undefined): boolean {
  return env?.VITE_DEMO === "true" || env?.VITE_DEMO === "1";
}
