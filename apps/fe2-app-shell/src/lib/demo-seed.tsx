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
import { identity as identityValues, appRegistry } from "@dub/types";
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
  "notif:broadcast_publish",
  "mail:read",
  "mail:send",
  "mail:admin",
  "chat:create",
  "audit:read",
  // Per-app RBAC gate keys (added by the #270 launcher RBAC): every route is now gated
  // on its `app:<id>:view` key, so the "broad" demo admin must carry the view+edit key
  // for every app or the whole shell 403s. Sourced from the SoT manifest so new apps are
  // covered automatically.
  ...appRegistry.allAppAccessKeys(),
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

// audience='admin' notifications powering the Notification管理 screen
// (/notifications/manage, gated on notif:broadcast_publish). Mutable in-session so
// the "メンバーへ公開" action persists (row stays 公開済み on reload) and the
// optimistic UI is confirmed by the (demo) server. Mirrors the three auto-admin
// notification kinds: deploy done / feature published / feedback.
const ADMIN_NOTIFICATIONS: notification.AdminNotificationItem[] = [
  { id: "ntfn_adm_0001", type: "deploy.deployment.status_changed", title: "デプロイ完了: dub-ecosystem", body: "本番へのデプロイが完了しました。", audience: "admin", createdAt: "2026-08-02T03:00:00Z", publishedBroadcastId: null },
  { id: "ntfn_adm_0002", type: "release", title: "🎉 ガントチャートをメンバー公開しました", body: "タスクの期間・進捗・依存をタイムラインで確認できます。", audience: "admin", createdAt: "2026-08-02T02:30:00Z", publishedBroadcastId: null },
  { id: "ntfn_adm_0003", type: "feedback", title: "新しいフィードバック: 検索が遅い", body: "カテゴリ: idea\n送信ユーザー: usr_alice\n\n検索ページが重いです", audience: "admin", createdAt: "2026-08-02T02:00:00Z", publishedBroadcastId: null },
  // Extra rows so the genre filter (新機能 / システム) and bulk select-all are demonstrable.
  { id: "ntfn_adm_0004", type: "release", title: "🎉 メール添付ファイルに対応しました", body: "メールの送受信で添付ファイルを扱えるようになりました。", audience: "admin", createdAt: "2026-08-02T01:45:00Z", publishedBroadcastId: null },
  { id: "ntfn_adm_0005", type: "release", title: "🎉 使用量ダッシュボードを公開しました", body: "各サービスの無料枠の使用状況を確認できます。", audience: "admin", createdAt: "2026-08-02T01:30:00Z", publishedBroadcastId: null },
  { id: "ntfn_adm_0006", type: "deploy.deployment.status_changed", title: "デプロイ完了: fe2-app-shell", body: "SPA シェルの本番デプロイが完了しました。", audience: "admin", createdAt: "2026-08-02T01:15:00Z", publishedBroadcastId: null },
  { id: "ntfn_adm_0007", type: "feedback", title: "新しいフィードバック: 通知の一括操作がほしい", body: "カテゴリ: idea\n送信ユーザー: usr_bob\n\n大量に公開する時に一括操作がほしいです", audience: "admin", createdAt: "2026-08-02T01:00:00Z", publishedBroadcastId: null },
];

// Publish one admin notification to members (idempotent). Flips the source row to 公開済み
// in-session and fans a single members broadcast into the inbox. Returns null on an unknown
// id. Shared by the single + bulk (publish-batch) demo endpoints.
function publishAdminNotificationDemo(id: string): notification.PublishBroadcastResponse | null {
  const adminItem = ADMIN_NOTIFICATIONS.find((a) => a.id === id);
  if (!adminItem) return null;
  if (adminItem.publishedBroadcastId) {
    return { notificationId: adminItem.publishedBroadcastId, deduplicated: true, publishedBroadcastId: adminItem.publishedBroadcastId };
  }
  const broadcastId = `ntf_bcast_${Math.random().toString(36).slice(2, 8)}`;
  adminItem.publishedBroadcastId = broadcastId;
  NOTIFICATIONS.unshift({ id: broadcastId, type: adminItem.type, title: adminItem.title, body: adminItem.body, readAt: null, createdAt: new Date().toISOString(), resourceType: "notification", resourceId: adminItem.id });
  return { notificationId: broadcastId, deduplicated: false, publishedBroadcastId: broadcastId };
}

// Unpublish (retract) one admin notification's members broadcast (idempotent — the inverse
// of publishAdminNotificationDemo). Flips the source row back to unpublished in-session and
// removes the broadcast from the member inbox. Returns null on an unknown id; retracted=false
// when it was never published (no-op). Shared by the single + bulk (unpublish-batch) endpoints.
function unpublishAdminNotificationDemo(id: string): notification.UnpublishBroadcastResponse | null {
  const adminItem = ADMIN_NOTIFICATIONS.find((a) => a.id === id);
  if (!adminItem) return null;
  const broadcastId = adminItem.publishedBroadcastId;
  if (!broadcastId) return { notificationId: id, retracted: false, removedBroadcastId: null };
  adminItem.publishedBroadcastId = null;
  for (let i = NOTIFICATIONS.length - 1; i >= 0; i--) {
    const n = NOTIFICATIONS[i]!;
    if (n.id === broadcastId || (n.resourceType === "notification" && n.resourceId === adminItem.id)) {
      NOTIFICATIONS.splice(i, 1);
    }
  }
  return { notificationId: id, retracted: true, removedBroadcastId: broadcastId };
}

// ── mail ────────────────────────────────────────────────────────────────────
// Demo attachment blob store: attId -> bytes (download links serve real bytes in-session).
const DEMO_MAIL_BLOBS = new Map<string, { filename: string; contentType: string; bytes: Uint8Array }>();
function seedMailBlob(id: string, filename: string, contentType: string, text: string): mail.MailAttachment {
  const bytes = new TextEncoder().encode(text);
  DEMO_MAIL_BLOBS.set(id, { filename, contentType, bytes });
  return { id, filename, contentType, sizeBytes: bytes.byteLength };
}
// Seed an image attachment from base64 bytes so the reading pane can show a real inline
// thumbnail (Gmail-style) in the demo/E2E — images render inline, other files download.
function seedMailImageBlob(id: string, filename: string, contentType: string, base64: string): mail.MailAttachment {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  DEMO_MAIL_BLOBS.set(id, { filename, contentType, bytes });
  return { id, filename, contentType, sizeBytes: bytes.byteLength };
}
// A tiny (8x8) solid-blue PNG — enough to render a visible inline thumbnail in the demo.
const DEMO_PNG_8x8 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNkYPhfz0AEYBpVSF+FAP7pAv4prsMnAAAAAElFTkSuQmCC";

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
  msg_1: {
    ...MAIL_LIST[0]!,
    textBody: "お世話になっております。山田です。\n\nカンファレンスでの登壇について相談させてください。テーマは『Cloudflare Workers 実践』を考えています。登壇資料のイメージ画像を添付します。\n\nよろしくお願いいたします。",
    attachments: [seedMailImageBlob("mailatt_demo_slide", "登壇イメージ.png", "image/png", DEMO_PNG_8x8)],
  },
  msg_2: {
    ...MAIL_LIST[1]!,
    textBody: "ACME株式会社の佐藤です。\n\nスポンサー契約書を送付いたします。ご確認のうえ、ご署名をお願いいたします。動画も添付しましたが容量が大きすぎたようです。",
    attachments: [
      seedMailBlob("mailatt_demo_contract", "スポンサー契約書.txt", "text/plain", "スポンサー契約書（デモ用サンプル）\n本契約は…"),
      // 改善#2: an over-ceiling attachment surfaces as a disabled chip with a reason,
      // instead of silently disappearing (no bytes stored; download would 409).
      { id: "mailatt_demo_big", filename: "会場紹介動画.mp4", contentType: "video/mp4", sizeBytes: 41943040, status: "dropped_too_large" },
    ],
  },
  msg_3: { ...MAIL_LIST[2]!, textBody: "運営スタッフです。来週火曜 14:00 から会場下見を予定しています。ご都合いかがでしょうか。" },
};

const MAIL_THREAD: Record<string, mail.MailThread> = {
  thr_1: { id: "thr_1", messages: [MAIL_DETAIL.msg_1!] },
  thr_2: { id: "thr_2", messages: [MAIL_DETAIL.msg_2!] },
  thr_3: { id: "thr_3", messages: [MAIL_DETAIL.msg_3!] },
};

// ── demo accounts (per-account mail scope) ────────────────────────────────────
// Two signed-in accounts so a viewer / the E2E can prove Gmail-style isolation in a
// real browser: each account sees ONLY its own inbox + sent mail. The active account
// is chosen by localStorage["dub_demo_account"] (email or id), read fresh on every
// request so a reload after switching accounts re-scopes everything. Default = the
// admin (usr_demo), so the existing single-account demo + E2E are unchanged.
export interface DemoAccount {
  id: string;
  displayName: string;
  email: string;
  permissions: identity.PermissionKey[];
  inbox: mail.MailMessageDetail[];
}

// Account B's inbox is a DISTINCT set (different sender/subject) so a screenshot makes
// the isolation obvious: none of account A's mail appears here, and vice versa.
const B_INBOX: mail.MailMessageDetail[] = [
  {
    id: "msg_b1", messageId: "<b1@demo>", threadId: "thr_b1",
    from: { email: "chair@example.org", name: "実行委員長" },
    to: [{ email: "taro@developershub.jp" }], subject: "委員会の議事録共有",
    snippet: "本日の運営委員会の議事録を共有します。", receivedAt: "2026-08-03T02:00:00Z", read: false,
    textBody: "佐藤さん\n\n本日の運営委員会の議事録を共有します。ご確認ください。",
  },
];

// Fixed archive address auto-CC'd on every send (mirrors the mail-gateway MAIL_ARCHIVE_CC
// behavior so the demo/E2E shows the archive copy in the Sent detail's Cc).
const DEMO_ARCHIVE_CC = "archive@developershub.jp";

// Oversight account (info@): an INDIVIDUAL admin account holding mail:read_all, so it
// sees EVERY account's inbox + sent mail — the supervisor / archive view. Contrast with
// the two personal accounts above, which each see only their own mail.
const OVERSIGHT_PERMISSIONS: identity.PermissionKey[] = [...DEMO_PERMISSIONS, "mail:read_all"];

// A general MEMBER account (no dangerous permissions → not privileged) so a viewer /
// the E2E can prove the member release gate: only member-published apps (メール) are
// active in the launcher, every other app is greyed-out. mail:read is granted so the
// one published app actually opens; no *:admin / *:send etc. so isPrivilegedViewer()
// stays false and the gate applies.
const MEMBER_ACCOUNT_PERMISSIONS: identity.PermissionKey[] = [
  "identity:read",
  "event:read",
  "task:read",
  "file:read",
  "notif:inbox:self",
  "notif:prefs:self",
  "mail:read",
];

const DEMO_ACCOUNTS: DemoAccount[] = [
  { id: ME_ID, displayName: "デモ 管理者", email: "demo@developershub.jp", permissions: DEMO_PERMISSIONS, inbox: Object.values(MAIL_DETAIL).map((m) => ({ ...m })) },
  { id: "usr_bob", displayName: "佐藤 太郎", email: "taro@developershub.jp", permissions: DEMO_PERMISSIONS, inbox: B_INBOX.map((m) => ({ ...m })) },
  { id: "usr_super", displayName: "監督 (info@)", email: "info@developershub.jp", permissions: OVERSIGHT_PERMISSIONS, inbox: [] },
  { id: "usr_member", displayName: "一般メンバー 花子", email: "hanako@developershub.jp", permissions: MEMBER_ACCOUNT_PERMISSIONS, inbox: [] },
];

/** True when the account holds the mail:read_all oversight permission. */
function isOversight(a: DemoAccount): boolean {
  return a.permissions.includes("mail:read_all");
}

const DEMO_ACCOUNT_STORAGE_KEY = "dub_demo_account";

/** The active demo account (localStorage-selected, default admin). Read per request. */
function currentAccount(): DemoAccount {
  let key: string | null = null;
  try {
    key = globalThis.localStorage?.getItem(DEMO_ACCOUNT_STORAGE_KEY) ?? null;
  } catch {
    key = null;
  }
  if (key) {
    const match = DEMO_ACCOUNTS.find((a) => a.id === key || a.email === key);
    if (match) return match;
  }
  return DEMO_ACCOUNTS[0]!;
}

/** The /me session for the active account (drives RequireAuth + the shell header). */
function currentMe(): gateway.MeResponse {
  const a = currentAccount();
  return {
    user: { id: a.id, displayName: a.displayName, avatarUrl: null, email: a.email },
    orgId: ORG,
    permissions: a.permissions,
    sessionExpiresAt: Date.now() + 60 * 60 * 1000,
  };
}

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
  // Per-account Inbox + Sent, mirroring the server's owner scope: each account sees ONLY
  // its own mail. received[accountId] is seeded (cloned) from the account's inbox so the
  // read flag can flip in-session; sent[accountId] starts empty. The active account is
  // resolved fresh on every request (currentAccount) so a reload after switching accounts
  // re-scopes every list. A message/thread/sent id owned by another account reads as 404.
  const received: Record<string, mail.MailMessageDetail[]> = {};
  let seq = 0;
  let attSeq = 0;
  const b64ToBytes = (b64: string): Uint8Array => {
    const bin = atob(b64.replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  function inboxOf(id: string): mail.MailMessageDetail[] {
    if (!received[id]) {
      const acct = DEMO_ACCOUNTS.find((a) => a.id === id);
      received[id] = (acct?.inbox ?? []).map((m) => ({ ...m }));
    }
    return received[id]!;
  }
  // Sent is PERSISTED per account (localStorage) so it survives a reload and stays
  // strictly account-scoped: a mail account A sent lives under A's key and is therefore
  // invisible when the shell reloads as account B. Read fresh on every request.
  const sentKey = (id: string): string => `dub_demo_sent_${id}`;
  function sentOf(id: string): mail.MailSentDetail[] {
    try {
      const raw = globalThis.localStorage?.getItem(sentKey(id));
      return raw ? (JSON.parse(raw) as mail.MailSentDetail[]) : [];
    } catch {
      return [];
    }
  }
  function saveSent(id: string, list: mail.MailSentDetail[]): void {
    try {
      globalThis.localStorage?.setItem(sentKey(id), JSON.stringify(list));
    } catch {
      /* storage unavailable — Sent is best-effort in the demo */
    }
  }

  function handle(method: string, pathname: string, _url: URL, body: unknown): Response | null {
    // attachment download (messages|sent): stream the stored blob as a file.
    {
      const m = /^\/api\/v1\/mail\/(?:messages|sent)\/[^/]+\/attachments\/([^/]+)$/.exec(pathname);
      if (m && method === "GET") {
        const blob = DEMO_MAIL_BLOBS.get(decodeURIComponent(m[1]!));
        if (!blob) return notFound(`GET ${pathname}`);
        return new Response(blob.bytes as BodyInit, {
          status: 200,
          headers: { "content-type": blob.contentType, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(blob.filename)}` },
        });
      }
    }
    const me = currentAccount();
    const outbox = sentOf(me.id);
    // Oversight (mail:read_all): the read views aggregate EVERY account's mail; personal
    // accounts stay scoped to their own. `readInbox` / `readSent` are the visible sets for
    // the current viewer. Writes (send / mark-read) still target the account they belong to.
    const oversight = isOversight(me);
    const readInbox: mail.MailMessageDetail[] = oversight ? DEMO_ACCOUNTS.flatMap((a) => inboxOf(a.id)) : inboxOf(me.id);
    const readSent: mail.MailSentDetail[] = oversight ? DEMO_ACCOUNTS.flatMap((a) => sentOf(a.id)) : outbox;

    // received: list / detail / mark-read (read state persists in-session). Scoped to the
    // account, or every account under oversight (mail:read_all).
    if (method === "GET" && pathname === "/api/v1/mail/messages") {
      const items: mail.MailMessageListItem[] = readInbox.map(({ textBody, htmlBody, ...li }) => {
        void textBody;
        void htmlBody;
        return li;
      });
      return json(page(items));
    }
    {
      const m = /^\/api\/v1\/mail\/messages\/([^/]+)$/.exec(pathname);
      if (m && method === "GET") {
        const found = readInbox.find((r) => r.id === decodeURIComponent(m[1]!));
        return found ? json(found) : notFound(`GET ${pathname}`);
      }
    }
    if (method === "POST") {
      const m = /^\/api\/v1\/mail\/messages\/([^/]+)\/read$/.exec(pathname);
      if (m) {
        const found = readInbox.find((r) => r.id === decodeURIComponent(m[1]!));
        if (!found) return notFound(`POST ${pathname}`); // another account's message (no oversight) → 404
        found.read = true;
        return json({ read: true });
      }
    }
    // thread: this account's messages in the thread (every account's under oversight).
    {
      const m = /^\/api\/v1\/mail\/threads\/([^/]+)$/.exec(pathname);
      if (m && method === "GET") {
        const threadId = decodeURIComponent(m[1]!);
        const messages = readInbox.filter((r) => r.threadId === threadId);
        return messages.length > 0 ? json({ id: threadId, messages } satisfies mail.MailThread) : notFound(`GET ${pathname}`);
      }
    }
    // sent: outbox append + list + detail — this account only
    if (method === "POST" && pathname === "/api/v1/mail/outbox") {
      const req = (body ?? {}) as Partial<mail.SendMailRequest>;
      const id = `sent_demo_${Date.now().toString(36)}_${seq++}`;
      const sentAt = new Date().toISOString();
      const providerMessageId = `<demo-${Date.now()}@developershub.jp>`;
      const attachments: mail.MailAttachment[] = (req.attachments ?? []).map((a) => {
        const attId = `mailatt_demo_${Date.now().toString(36)}_${attSeq++}`;
        const bytes = b64ToBytes(a.contentBase64);
        DEMO_MAIL_BLOBS.set(attId, { filename: a.filename, contentType: a.contentType, bytes });
        return { id: attId, filename: a.filename, contentType: a.contentType, sizeBytes: bytes.byteLength };
      });
      // Auto-CC the archive address (dedup against To/Cc) — mirrors MAIL_ARCHIVE_CC.
      const baseCc = req.cc ?? [];
      const alreadyArchived = [...(req.to ?? []), ...baseCc].some((a) => a.email?.trim().toLowerCase() === DEMO_ARCHIVE_CC);
      const cc = alreadyArchived ? baseCc : [...baseCc, { email: DEMO_ARCHIVE_CC }];
      const detail: mail.MailSentDetail = {
        id,
        from: { email: me.email, name: me.displayName },
        to: req.to ?? [],
        ...(cc.length > 0 ? { cc } : {}),
        subject: req.subject ?? "(件名なし)",
        snippet: firstLine(req.textBody ?? ""),
        sentAt,
        provider: "resend",
        providerMessageId,
        status: "sent",
        textBody: req.textBody ?? "",
        ...(req.htmlBody ? { htmlBody: req.htmlBody } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      outbox.unshift(detail);
      saveSent(me.id, outbox);
      const res: mail.SendMailResponse = { messageId: providerMessageId, provider: "resend", acceptedAt: sentAt };
      return json(res);
    }
    if (method === "GET" && pathname === "/api/v1/mail/sent") {
      const items: mail.MailSentListItem[] = readSent.map(({ textBody, htmlBody, ...listItem }) => {
        void textBody;
        void htmlBody;
        return listItem;
      });
      return json(page(items));
    }
    if (method === "GET") {
      const m = /^\/api\/v1\/mail\/sent\/([^/]+)$/.exec(pathname);
      if (m) {
        const found = readSent.find((s) => s.id === decodeURIComponent(m[1]!));
        return found ? json(found) : notFound(`GET ${pathname}`);
      }
    }
    // 改善#8: per-user thread flags (star/archive/trash), persisted in localStorage so they
    // SURVIVE a reload in the demo (mirrors the real gateway persisting them server-side).
    if (method === "GET" && pathname === "/api/v1/mail/flags") {
      return json({ items: loadFlags() });
    }
    if (method === "POST") {
      const m = /^\/api\/v1\/mail\/flags\/([^/]+)$/.exec(pathname);
      if (m) {
        const threadId = decodeURIComponent(m[1]!);
        const patch = (body ?? {}) as Partial<mail.MailThreadFlagsPatch>;
        const flags = loadFlags();
        const prev = flags.find((f) => f.threadId === threadId) ?? { threadId, starred: false, archived: false, trashed: false };
        const next: mail.MailThreadFlags = {
          threadId,
          starred: patch.starred ?? prev.starred,
          archived: patch.archived ?? prev.archived,
          trashed: patch.trashed ?? prev.trashed,
        };
        saveFlags([...flags.filter((f) => f.threadId !== threadId), next]);
        return json(next);
      }
    }
    return null;
  }

  return { handle };
}

// Thread-flags persistence for the demo (localStorage; survives reload).
const FLAGS_KEY = "dub-demo-mail-flags";
function loadFlags(): mail.MailThreadFlags[] {
  try {
    const raw = globalThis.localStorage?.getItem(FLAGS_KEY);
    return raw ? (JSON.parse(raw) as mail.MailThreadFlags[]) : [];
  } catch {
    return [];
  }
}
function saveFlags(flags: mail.MailThreadFlags[]): void {
  try {
    globalThis.localStorage?.setItem(FLAGS_KEY, JSON.stringify(flags));
  } catch {
    /* ignore */
  }
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
// ── chat (FE6) ────────────────────────────────────────────────────────────────
// Read-mostly chat seed for the demo transport: a full Slack-style channel set so
// the sidebar renders 全体 / チーム別 / 役割別 channels out of the box. Channel names
// stay romaji for consistency (#7); Japanese topics describe each one. Team channels
// mirror member-service's real 運営チーム (統括/開発/当日進行/スポンサー/会場/集客広報)
// — no invented teams. Messages/WS are not seeded (no WS in demo): channels open to a
// clean empty timeline; the sidebar list is the enriched surface.
interface DemoChatChannel {
  id: string;
  type: "topic" | "event" | "dm";
  name: string;
  topic: string | null;
  eventId: string | null;
  memberCount: number;
}

function createChatStore() {
  const CH_TS = "2026-08-01T00:00:00.000Z";
  // 全体: everyone. announcements is the read-mostly 全体周知 channel.
  const overall: DemoChatChannel[] = [
    { id: "chn_general", type: "topic", name: "general", topic: "全体連絡・雑多な共有 📣", eventId: null, memberCount: 24 },
    { id: "chn_announcements", type: "topic", name: "announcements", topic: "運営からのお知らせ・全体周知（重要連絡）", eventId: null, memberCount: 24 },
    { id: "chn_random", type: "topic", name: "random", topic: "雑談なんでも ☕", eventId: null, memberCount: 21 },
  ];
  // チーム別: one per real member-service 運営チーム (key / 表示名 / 説明はロスター準拠).
  const teamChannels: DemoChatChannel[] = [
    { id: "chn_team_soukatsu", type: "topic", name: "team-soukatsu", topic: "統括チーム — 全体意思決定・進行統制・チーム間調整", eventId: null, memberCount: 3 },
    { id: "chn_team_dev", type: "topic", name: "team-dev", topic: "開発チーム — 運営ツール内製・名簿・当日連絡基盤", eventId: null, memberCount: 3 },
    { id: "chn_team_ops", type: "topic", name: "team-ops", topic: "当日進行チーム — 進行管理・タイムテーブル・人員配置", eventId: null, memberCount: 2 },
    { id: "chn_team_sponsor", type: "topic", name: "team-sponsor", topic: "スポンサーチーム — 協賛打診・メニュー設計・契約", eventId: null, memberCount: 2 },
    { id: "chn_team_venue", type: "topic", name: "team-venue", topic: "会場チーム — 会場・設営・ネットワーク／配信", eventId: null, memberCount: 2 },
    { id: "chn_team_pr", type: "topic", name: "team-pr", topic: "集客広報チーム — LP・SNS・デザイン・広報／集客", eventId: null, memberCount: 3 },
  ];
  // 役割/目的別: cross-cutting roles & workstreams that span teams.
  const roleChannels: DemoChatChannel[] = [
    { id: "chn_admin", type: "topic", name: "admin", topic: "管理者運用・権限管理・全体統制（admin 向け）", eventId: null, memberCount: 4 },
    { id: "chn_maintainers", type: "topic", name: "maintainers", topic: "メンテナ調整・リリース判断・レビュー割当", eventId: null, memberCount: 5 },
    { id: "chn_dev", type: "topic", name: "dev", topic: "開発・デプロイ・コードレビュー", eventId: null, memberCount: 8 },
    { id: "chn_design", type: "topic", name: "design", topic: "UI/UX・デザインレビュー", eventId: null, memberCount: 6 },
    { id: "chn_pr", type: "topic", name: "pr-koho", topic: "広報・集客・SNS 運用（目的別）", eventId: null, memberCount: 6 },
    { id: "chn_help", type: "topic", name: "help", topic: "質問・困りごと・サポート", eventId: null, memberCount: 24 },
  ];
  // イベント: the conference operations channel (grouped under イベント in the sidebar).
  const eventChannels: DemoChatChannel[] = [
    { id: "chn_evt_conf", type: "event", name: "北陸itカンファレンス", topic: "北陸ITカンファレンス2026 運営チャネル", eventId: "evt_1", memberCount: 18 },
  ];
  const all = [...overall, ...teamChannels, ...roleChannels, ...eventChannels];

  const toWire = (c: DemoChatChannel) => ({
    id: c.id,
    orgId: ORG,
    type: c.type,
    name: c.name,
    topic: c.topic,
    eventId: c.eventId,
    archived: false,
    memberCount: c.memberCount,
    version: 1,
    createdAt: CH_TS,
    updatedAt: CH_TS,
  });
  const byId = new Map(all.map((c) => [c.id, c]));

  function handle(method: string, pathname: string, url: URL, _body: unknown): Response | null {
    if (method === "GET" && pathname === "/api/v1/chat/channels") {
      // Optional ?eventId= filter (contract): event channels for that event only.
      const eventId = url.searchParams.get("eventId");
      const list = eventId ? all.filter((c) => c.eventId === eventId) : all;
      return json(list.map(toWire)); // raw array (not Paginated) per fe6 contract
    }
    if (method === "GET" && pathname === "/api/v1/chat/unread") {
      return json([]); // no unread badges in demo
    }
    {
      const m = /^\/api\/v1\/chat\/channels\/([^/]+)$/.exec(pathname);
      if (m && method === "GET") {
        const c = byId.get(decodeURIComponent(m[1]!));
        if (!c) return notFound(`GET ${pathname}`);
        return json({ channel: toWire(c), membership: { channelId: c.id, userId: ME_ID, role: "member", joinedAt: CH_TS } });
      }
    }
    {
      const m = /^\/api\/v1\/chat\/channels\/([^/]+)\/read$/.exec(pathname);
      if (m && method === "POST") return json(null, 204);
    }
    if (method === "GET" && pathname === "/api/v1/chat/messages") {
      return json(page([])); // empty timeline (Paginated envelope)
    }
    return null;
  }

  return { handle };
}

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
function matchDemoRoute(method: string, pathname: string, url: URL, body?: unknown): Response | null {
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
    // admin: Notification管理 list (audience='admin' notifications to publish).
    if (pathname === "/api/v1/notifications/manage") {
      return json(page(ADMIN_NOTIFICATIONS.map((a) => ({ ...a }))));
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
    // chat channels/messages/unread are served by the stateful chat store
    // (createChatStore) so the sidebar renders a full 全体/チーム別/役割別 channel set
    // — mirrors member-service's real 運営チーム names. See createDemoFetch below.
  }

  if (method === "POST") {
    // mail read + send are served by the stateful mail store (createMailStore).
    if (pathname === "/api/v1/notifications/inbox/read-all") return json(null, 204);
    // admin: bulk publish a selection in one request (idempotent, per-item outcomes).
    if (pathname === "/api/v1/notifications/manage/publish-batch") {
      const ids = Array.isArray((body as { ids?: unknown })?.ids) ? ((body as { ids: string[] }).ids) : [];
      const seen = new Set<string>();
      const results: notification.PublishBroadcastBatchItem[] = [];
      let publishedCount = 0, deduplicatedCount = 0, failedCount = 0;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const r = publishAdminNotificationDemo(id);
        if (!r) { results.push({ id, ok: false, code: "NOTIF_NOTIFICATION_NOT_FOUND" }); failedCount++; continue; }
        results.push({ id, ok: true, deduplicated: r.deduplicated, publishedBroadcastId: r.publishedBroadcastId });
        if (r.deduplicated) deduplicatedCount++; else publishedCount++;
      }
      return json({ results, publishedCount, deduplicatedCount, failedCount });
    }
    // admin: bulk unpublish a selection in one request (idempotent, per-item outcomes).
    if (pathname === "/api/v1/notifications/manage/unpublish-batch") {
      const ids = Array.isArray((body as { ids?: unknown })?.ids) ? ((body as { ids: string[] }).ids) : [];
      const seen = new Set<string>();
      const results: notification.UnpublishBroadcastBatchItem[] = [];
      let retractedCount = 0, noopCount = 0, failedCount = 0;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const r = unpublishAdminNotificationDemo(id);
        if (!r) { results.push({ id, ok: false, code: "NOTIF_NOTIFICATION_NOT_FOUND" }); failedCount++; continue; }
        const item: notification.UnpublishBroadcastBatchItem = { id, ok: true, retracted: r.retracted };
        if (r.removedBroadcastId) item.removedBroadcastId = r.removedBroadcastId;
        results.push(item);
        if (r.retracted) retractedCount++; else noopCount++;
      }
      return json({ results, retractedCount, noopCount, failedCount });
    }
    // admin: unpublish (retract) one admin notification's broadcast (idempotent). Flips the
    // source row back to unpublished in-session and removes the broadcast from the member
    // inbox, so the optimistic UI is confirmed and a reload keeps the unpublished state.
    {
      const uid = seg(/^\/api\/v1\/notifications\/manage\/([^/]+)\/unpublish$/);
      if (uid) {
        const r = unpublishAdminNotificationDemo(uid);
        return r ? json(r) : notFound(`POST ${pathname}`);
      }
    }
    // admin: publish one admin notification to all members (idempotent). Flips the
    // source row to 公開済み in-session and fans a single members broadcast into the
    // inbox, so the optimistic UI is confirmed and a reload keeps the published state.
    {
      const id = seg(/^\/api\/v1\/notifications\/manage\/([^/]+)\/publish$/);
      if (id) {
        const r = publishAdminNotificationDemo(id);
        return r ? json(r) : notFound(`POST ${pathname}`);
      }
    }
  }

  if (method === "PATCH") {
    if (/^\/api\/v1\/notifications\/inbox\/[^/]+\/read$/.test(pathname)) return json(null, 204);
    if (pathname === "/api/v1/notifications/preferences") return json(null, 204);
  }

  return null;
}

// ── driveshare: stateful Hackit Drive sharing manager ─────────────────────────
// A tiny in-session store so the Drive sharing manager behaves end-to-end without a
// backend: list files (name filter), list a file's permissions, grant/change/revoke,
// and toggle link (anyone) sharing — all persist in-session (a reload resets). Mirrors
// drive-share-service's mock client seed. No real Drive is touched.
interface DemoDrivePermission {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: "reader" | "commenter" | "writer" | "owner";
  emailAddress: string | null;
  displayName: string | null;
  domain: string | null;
  /** Inherited from an ancestor folder → Drive refuses to change/remove it on this
   *  item (403 cannotDeletePermission); the manager shows it read-only. Optional in the
   *  seed literals (defaults to false in permsView). */
  inherited?: boolean;
}
interface DemoDriveFile {
  id: string;
  name: string;
  mimeType: string;
  ownerName: string;
  modifiedTime: string;
  webViewLink: string;
  /** Parent folder id (null at the shared-drive root). Drives the lazy tree: a
   *  GET /driveshare/files?folderId=X returns exactly the direct children of X. */
  parentId: string | null;
  permissions: DemoDrivePermission[];
}
const DRIVE_FOLDER_MIME_DEMO = "application/vnd.google-apps.folder";

function createDriveShareStore() {
  const owner = (id: string): DemoDrivePermission => ({
    id,
    type: "user",
    role: "owner",
    emailAddress: "hackit@gmail.com",
    displayName: "Hackit 運営",
    domain: null,
  });
  const link = (id: string) => `https://drive.google.com/file/d/${id}/view`;
  const files: DemoDriveFile[] = [
    // ── root (parentId=null): the pre-existing five, unchanged (existing E2E depends on
    //    予算管理 / チラシ being at the top level). ─────────────────────────────────
    {
      id: "fld_root", name: "Hackit 2026 共有", mimeType: DRIVE_FOLDER_MIME_DEMO, ownerName: "Hackit 運営",
      modifiedTime: "2026-08-10T09:00:00Z", webViewLink: link("fld_root"), parentId: null,
      permissions: [owner("perm_1"), { id: "perm_2", type: "user", role: "writer", emailAddress: "staff-a@example.com", displayName: "スタッフA", domain: null }],
    },
    {
      id: "fld_designs", name: "デザイン素材", mimeType: DRIVE_FOLDER_MIME_DEMO, ownerName: "Hackit 運営",
      modifiedTime: "2026-08-11T02:30:00Z", webViewLink: link("fld_designs"), parentId: null, permissions: [owner("perm_3")],
    },
    {
      id: "fil_budget", name: "予算管理.xlsx", mimeType: "application/vnd.google-apps.spreadsheet", ownerName: "Hackit 運営",
      modifiedTime: "2026-08-11T23:10:00Z", webViewLink: link("fil_budget"), parentId: null,
      permissions: [owner("perm_4"), { id: "perm_5", type: "user", role: "reader", emailAddress: "sponsor@example.com", displayName: "協賛担当", domain: null }],
    },
    {
      id: "fil_flyer", name: "当日チラシ.pdf", mimeType: "application/pdf", ownerName: "Hackit 運営",
      modifiedTime: "2026-08-12T01:00:00Z", webViewLink: link("fil_flyer"), parentId: null,
      permissions: [owner("perm_6"), { id: "perm_anyone_flyer", type: "anyone", role: "reader", emailAddress: null, displayName: null, domain: null }],
    },
    {
      id: "fil_runsheet", name: "進行台本.gdoc", mimeType: "application/vnd.google-apps.document", ownerName: "Hackit 運営",
      modifiedTime: "2026-08-12T03:45:00Z", webViewLink: link("fil_runsheet"), parentId: null,
      permissions: [owner("perm_7"), { id: "perm_8", type: "user", role: "commenter", emailAddress: "mc@example.com", displayName: "司会", domain: null }],
    },

    // ── children of fld_root (depth 1) ────────────────────────────────────────────
    {
      id: "fld_sponsors", name: "スポンサー資料", mimeType: DRIVE_FOLDER_MIME_DEMO, ownerName: "Hackit 運営",
      modifiedTime: "2026-08-11T05:00:00Z", webViewLink: link("fld_sponsors"), parentId: "fld_root", permissions: [owner("perm_10")],
    },
    {
      id: "fil_schedule", name: "全体スケジュール.gsheet", mimeType: "application/vnd.google-apps.spreadsheet", ownerName: "Hackit 運営",
      modifiedTime: "2026-08-11T06:00:00Z", webViewLink: link("fil_schedule"), parentId: "fld_root",
      permissions: [
        owner("perm_11"),
        { id: "perm_12", type: "user", role: "reader", emailAddress: "ops@example.com", displayName: "運営", domain: null },
        // Inherited from the parent folder (fld_root): the manager must show these as
        // read-only (継承) and refuse revoke/role-change / link-off, mirroring Drive's
        // real cannotDeletePermission. Drives the drive-revoke-fix E2E.
        { id: "perm_inh_staffa", type: "user", role: "writer", emailAddress: "staff-a@example.com", displayName: "スタッフA", domain: null, inherited: true },
        { id: "perm_inh_anyone", type: "anyone", role: "reader", emailAddress: null, displayName: null, domain: null, inherited: true },
      ],
    },
    // ── children of fld_sponsors (depth 2 — proves nesting beyond one level) ───────
    {
      id: "fil_contract", name: "協賛契約書.pdf", mimeType: "application/pdf", ownerName: "Hackit 運営",
      modifiedTime: "2026-08-11T07:00:00Z", webViewLink: link("fil_contract"), parentId: "fld_sponsors", permissions: [owner("perm_13")],
    },
    {
      id: "fil_sponsor_deck", name: "協賛メニュー.pdf", mimeType: "application/pdf", ownerName: "Hackit 運営",
      modifiedTime: "2026-08-11T07:30:00Z", webViewLink: link("fil_sponsor_deck"), parentId: "fld_sponsors", permissions: [owner("perm_14")],
    },

    // ── children of fld_designs (depth 1) ─────────────────────────────────────────
    {
      id: "fld_banners", name: "バナー", mimeType: DRIVE_FOLDER_MIME_DEMO, ownerName: "Hackit 運営",
      modifiedTime: "2026-08-11T03:00:00Z", webViewLink: link("fld_banners"), parentId: "fld_designs", permissions: [owner("perm_15")],
    },
    {
      id: "fil_poster", name: "ポスター.png", mimeType: "image/png", ownerName: "Hackit 運営",
      modifiedTime: "2026-08-11T03:30:00Z", webViewLink: link("fil_poster"), parentId: "fld_designs", permissions: [owner("perm_16")],
    },
    // ── children of fld_banners (depth 2) ─────────────────────────────────────────
    {
      id: "fil_web_banner", name: "Webバナー.png", mimeType: "image/png", ownerName: "Hackit 運営",
      modifiedTime: "2026-08-11T04:00:00Z", webViewLink: link("fil_web_banner"), parentId: "fld_banners", permissions: [owner("perm_17")],
    },
  ];
  const byId = new Map(files.map((f) => [f.id, f]));
  let seq = 100;

  // ── role-based grants (identity roles → whole-role Drive sharing) ─────────────
  // Mirrors drive-share-service's role-grants fan-out: granting a role to a file
  // expands to a Drive permission per role member (memberCount), tracked so revoke
  // can undo them and re-apply can re-sync. roleMembers / ROLE_NAME mirror the
  // identity roster's roles (GET /identity/roles: admin / maintainer / member).
  const ROLE_NAME: Record<string, string> = { role_admin: "admin", role_maintainer: "maintainer", role_member: "member" };
  const roleMembers: Record<string, string[]> = {
    // info@/admin@ are Cloudflare Email-Routing aliases with NO Google account (mirrors
    // the real bug): they ARE shared, but only via an invite, so their access is pending.
    role_admin: ["info@developershub.jp", "admin@developershub.jp"],
    role_maintainer: ["taro@developershub.jp", "araki@developershub.jp", "ikeda@developershub.jp"],
    // The last address has no Google account AND is invalid: the fan-out applies the
    // others and reports this one as skipped, instead of failing the whole role.
    role_member: ["ichiro@developershub.jp", "jiro@developershub.jp", "ghost-no-account@example.invalid"],
  };
  // Addresses that have no backing Google account → shareable only via an invite
  // (pending). Mirrors real Email-Routing aliases like info@/admin@developershub.jp.
  const NO_GOOGLE_ACCOUNT = new Set(["info@developershub.jp", "admin@developershub.jp"]);
  interface DemoRoleGrant {
    id: string;
    fileId: string;
    roleId: string;
    roleName: string;
    driveRole: "reader" | "commenter" | "writer";
    memberCount: number;
    appliedCount: number;
    grantedBy: string;
    grantedAt: string;
    permIds: string[]; // internal: the fanned-out Drive permission ids on the file
  }
  const roleGrants: DemoRoleGrant[] = [];
  type FanResult = { skipped: { email: string; reason: string }[]; invited: { email: string }[] };
  const grantView = (g: DemoRoleGrant, extra: Partial<FanResult> = {}) => ({
    id: g.id, fileId: g.fileId, roleId: g.roleId, roleName: g.roleName, driveRole: g.driveRole,
    memberCount: g.memberCount, appliedCount: g.appliedCount, grantedBy: g.grantedBy, grantedAt: g.grantedAt,
    ...(extra.skipped && extra.skipped.length > 0 ? { skipped: extra.skipped } : {}),
    ...(extra.invited && extra.invited.length > 0 ? { invited: extra.invited } : {}),
  });
  // Fan a role's members out onto a file as individual Drive permissions. Mirrors the
  // real service: a malformed email is skipped with a reason; a no-Google-account address
  // is applied but flagged `invited` (pending); the rest apply normally — a partial
  // success, never an all-or-nothing failure.
  const fanOut = (f: DemoDriveFile, g: DemoRoleGrant): FanResult => {
    const emails = roleMembers[g.roleId] ?? [];
    const skipped: { email: string; reason: string }[] = [];
    const invited: { email: string }[] = [];
    let applied = 0;
    for (const email of emails) {
      if (!EMAIL_RE.test(email) || email.endsWith(".invalid")) {
        skipped.push({ email, reason: "このメールアドレスとは共有できませんでした（Googleアカウントが無い、または無効なアドレスです）。" });
        continue;
      }
      const id = `perm_role_${seq++}`;
      g.permIds.push(id);
      f.permissions.push({ id, type: "user", role: g.driveRole, emailAddress: email, displayName: email.split("@")[0]!, domain: null });
      applied++;
      if (NO_GOOGLE_ACCOUNT.has(email)) invited.push({ email }); // shared via invite → pending
    }
    g.appliedCount = applied;
    return { skipped, invited };
  };
  const clearFan = (f: DemoDriveFile, g: DemoRoleGrant): void => {
    f.permissions = f.permissions.filter((p) => !g.permIds.includes(p.id));
    g.permIds = [];
  };

  const fileView = (f: DemoDriveFile) => ({
    id: f.id, name: f.name, mimeType: f.mimeType, isFolder: f.mimeType === DRIVE_FOLDER_MIME_DEMO,
    ownerName: f.ownerName, modifiedTime: f.modifiedTime, webViewLink: f.webViewLink,
    linkShared: f.permissions.some((p) => p.type === "anyone"),
  });
  const permsView = (f: DemoDriveFile) => ({ fileId: f.id, permissions: f.permissions.map((p) => ({ ...p, inherited: p.inherited ?? false })) });

  function handle(method: string, pathname: string, url: URL, body: unknown): Response | null {
    // ── role-based grants (matched before the generic file routes) ─────────────
    if (method === "GET" && pathname === "/api/v1/driveshare/role-grants") {
      return json({ items: roleGrants.map((g) => grantView(g)) });
    }
    const reapplyMatch = /^\/api\/v1\/driveshare\/files\/([^/]+)\/role-grants\/([^/]+)\/reapply$/.exec(pathname);
    if (reapplyMatch && method === "POST") {
      const f = byId.get(reapplyMatch[1]!);
      const g = roleGrants.find((x) => x.fileId === reapplyMatch[1]! && x.roleId === decodeURIComponent(reapplyMatch[2]!));
      if (!f || !g) return notFound(`${method} ${pathname}`);
      clearFan(f, g);
      const result = fanOut(f, g);
      return json(grantView(g, result));
    }
    const roleGrantItemMatch = /^\/api\/v1\/driveshare\/files\/([^/]+)\/role-grants\/([^/]+)$/.exec(pathname);
    if (roleGrantItemMatch && method === "DELETE") {
      const f = byId.get(roleGrantItemMatch[1]!);
      const roleId = decodeURIComponent(roleGrantItemMatch[2]!);
      const idx = roleGrants.findIndex((x) => x.fileId === roleGrantItemMatch[1]! && x.roleId === roleId);
      if (!f || idx === -1) return notFound(`${method} ${pathname}`);
      clearFan(f, roleGrants[idx]!);
      roleGrants.splice(idx, 1);
      return json({ ok: true });
    }
    const roleGrantsMatch = /^\/api\/v1\/driveshare\/files\/([^/]+)\/role-grants$/.exec(pathname);
    if (roleGrantsMatch) {
      const f = byId.get(roleGrantsMatch[1]!);
      if (!f) return notFound(`${method} ${pathname}`);
      if (method === "GET") return json({ items: roleGrants.filter((g) => g.fileId === f.id).map((g) => grantView(g)) });
      if (method === "POST") {
        const req = body as { roleId?: string; driveRole?: DemoRoleGrant["driveRole"] };
        const roleId = req.roleId ?? "";
        if (!roleId || !(roleId in ROLE_NAME)) return problem("VALIDATION", "unknown roleId", 400);
        if (roleGrants.some((g) => g.fileId === f.id && g.roleId === roleId)) {
          return problem("CONFLICT", "role already granted on this file", 409);
        }
        const emails = roleMembers[roleId] ?? [];
        const g: DemoRoleGrant = {
          id: `rg_${seq++}`, fileId: f.id, roleId, roleName: ROLE_NAME[roleId]!, driveRole: req.driveRole ?? "reader",
          memberCount: emails.length, appliedCount: 0, grantedBy: "demo@developershub.jp", grantedAt: new Date().toISOString(), permIds: [],
        };
        const result = fanOut(f, g);
        roleGrants.push(g);
        return json(grantView(g, result), 201);
      }
    }
    if (method === "GET" && pathname === "/api/v1/driveshare/files") {
      const needle = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const folderId = url.searchParams.get("folderId");
      // search (q) → GLOBAL flat match (parent ignored); else folderId → direct
      // children; else the root level (parentId === null). Mirrors mock-client.ts.
      const scope = needle
        ? files.filter((f) => f.name.toLowerCase().includes(needle))
        : folderId
          ? files.filter((f) => f.parentId === folderId)
          : files.filter((f) => f.parentId === null);
      const matched = scope
        .slice()
        .sort((a, b) => {
          const af = a.mimeType === DRIVE_FOLDER_MIME_DEMO ? 0 : 1;
          const bf = b.mimeType === DRIVE_FOLDER_MIME_DEMO ? 0 : 1;
          return af !== bf ? af - bf : a.name.localeCompare(b.name, "ja");
        });
      return json({ files: matched.map(fileView), nextCursor: null });
    }
    const permsMatch = /^\/api\/v1\/driveshare\/files\/([^/]+)\/permissions$/.exec(pathname);
    if (permsMatch) {
      const f = byId.get(permsMatch[1]!);
      if (!f) return notFound(`${method} ${pathname}`);
      if (method === "GET") return json(permsView(f));
      if (method === "POST") {
        const req = body as { emailAddress?: string; role?: DemoDrivePermission["role"] };
        const perm: DemoDrivePermission = {
          id: `perm_demo_${seq++}`, type: "user", role: req.role ?? "reader",
          emailAddress: req.emailAddress ?? null, displayName: req.emailAddress ? req.emailAddress.split("@")[0]! : null, domain: null,
        };
        f.permissions.push(perm);
        return json({ permission: perm }, 201);
      }
    }
    const permMatch = /^\/api\/v1\/driveshare\/files\/([^/]+)\/permissions\/([^/]+)$/.exec(pathname);
    if (permMatch) {
      const f = byId.get(permMatch[1]!);
      if (!f) return notFound(`${method} ${pathname}`);
      const perm = f.permissions.find((p) => p.id === permMatch[2]!);
      if (method === "PATCH") {
        if (!perm) return notFound(`${method} ${pathname}`);
        if (perm.inherited)
          return problem("FORBIDDEN", "この権限は親フォルダから継承されているため、このファイル単体では変更できません。親フォルダの共有設定で操作してください。", 403);
        perm.role = (body as { role?: DemoDrivePermission["role"] }).role ?? perm.role;
        return json({ permission: { ...perm } });
      }
      if (method === "DELETE") {
        // Mirror Drive's 403 cannotDeletePermission: an inherited permission cannot be
        // removed on this item. (The manager hides the revoke for these rows, so this
        // is defence-in-depth / fidelity for anything that hits the endpoint directly.)
        if (perm?.inherited)
          return problem("FORBIDDEN", "この権限は親フォルダから継承されているため、このファイル単体では剥奪できません。親フォルダの共有設定で操作してください。", 403);
        if (perm) f.permissions = f.permissions.filter((p) => p.id !== perm.id);
        return json({ revoked: true });
      }
    }
    const linkMatch = /^\/api\/v1\/driveshare\/files\/([^/]+)\/link$/.exec(pathname);
    if (linkMatch && method === "PUT") {
      const f = byId.get(linkMatch[1]!);
      if (!f) return notFound(`${method} ${pathname}`);
      const req = body as { enabled?: boolean; role?: DemoDrivePermission["role"] };
      const existing = f.permissions.find((p) => p.type === "anyone");
      // An inherited anyone (link) permission can't be toggled off on this item.
      if (!req.enabled && existing?.inherited)
        return problem("FORBIDDEN", "リンク共有は親フォルダから継承されているため、このファイル単体ではオフにできません。親フォルダの共有設定で操作してください。", 403);
      if (req.enabled) {
        if (existing) existing.role = req.role ?? "reader";
        else f.permissions.push({ id: `perm_anyone_${seq++}`, type: "anyone", role: req.role ?? "reader", emailAddress: null, displayName: null, domain: null });
      } else if (existing) {
        f.permissions = f.permissions.filter((p) => p.id !== existing.id);
      }
      return json(permsView(f));
    }
    return null;
  }

  return { handle };
}

// ── members (運営メンバー管理) ─────────────────────────────────────────────────
// In-memory 運営メンバー store for the demo transport: seeded with a few teams +
// members across all statuses, and full CRUD so add/edit/delete/status/team all
// persist for the session (a reload resets). Mirrors services/member-service's wire
// shapes (/api/v1/members/*).
interface DemoTeam {
  id: string;
  key: string;
  name: string;
  color: string | null;
  description: string | null;
}
interface DemoMember {
  id: string;
  orgId: string;
  name: string;
  roleTitle: string | null;
  status: "added" | "invited" | "considering" | "declined";
  teamIds: string[];
  department: string | null;
  grade: string | null;
  identityUserId: string | null;
  contact: string | null;
  schoolEmail: string | null;
  gmail: string | null;
  lastName: string | null;
  firstName: string | null;
  lastNameKana: string | null;
  firstNameKana: string | null;
  lastNameRomaji: string | null;
  firstNameRomaji: string | null;
  phone: string | null;
  note: string | null;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

function createMembersStore() {
  let seq = 100;
  const nid = (p: string): string => `${p}_demo_${++seq}`;
  // PDF「全体組織体制図」に寄せた構成: 統括チーム＋色付き5チーム、役割段は roleTitle で表現。
  const teams: DemoTeam[] = [
    { id: "team_hq", key: "soukatsu", name: "統括チーム", color: "#1e3a5f", description: "全体意思決定・進行統制・チーム間調整" },
    { id: "team_dev", key: "dev", name: "開発チーム", color: "#0d9488", description: "運営ツール内製・名簿・当日連絡基盤" },
    { id: "team_ops", key: "ops", name: "当日進行チーム", color: "#2563eb", description: "進行管理・タイムテーブル・人員配置" },
    { id: "team_sponsor", key: "sponsor", name: "スポンサーチーム", color: "#ea580c", description: "協賛打診・メニュー設計・契約" },
    { id: "team_venue", key: "venue", name: "会場チーム", color: "#16a34a", description: "会場・設営・ネットワーク／配信" },
    { id: "team_pr", key: "pr", name: "集客広報チーム", color: "#db2777", description: "LP・SNS・デザイン・広報／集客" },
  ];
  const mk = (
    id: string,
    name: string,
    roleTitle: string | null,
    status: DemoMember["status"],
    teamIds: string[],
    i: number,
    contact: string | null = null,
    department: string | null = null,
    grade: string | null = null,
    identityUserId: string | null = null,
  ): DemoMember => ({
    id, orgId: ORG, name, roleTitle, status, teamIds, department, grade, identityUserId, contact, schoolEmail: null, gmail: null, lastName: null, firstName: null, lastNameKana: null, firstNameKana: null, lastNameRomaji: null, firstNameRomaji: null, phone: null, note: null, sortOrder: (i + 1) * 1024, version: 1, createdAt: isoNow(), updatedAt: isoNow(),
  });
  const members: DemoMember[] = [
    // 統括 — 高岡 is already linked to the admin login account (demonstrates #1/#2).
    mk("member_1", "高岡 己太朗", "実行委員長", "added", ["team_hq"], 0, "kota@developershub.jp", "情報工学科", "3年", ME_ID),
    mk("member_h2", "黒川", "統括メンバー", "added", ["team_hq"], 1, null, "情報工学科", "3年"),
    mk("member_h3", "金井", "統括メンバー", "added", ["team_hq"], 2, null, "電気電子工学科", "2年"),
    // 開発
    mk("member_d1", "荒木", "オーガナイザー", "added", ["team_dev"], 3, null, "情報工学科", "M1"),
    mk("member_d2", "阿閉", "リーダー", "added", ["team_dev"], 4, null, "情報工学科", "3年"),
    mk("member_d3", "池田", "メンバー", "added", ["team_dev"], 5, null, "情報工学科", "1年"),
    // 当日進行
    mk("member_o1", "久米", "オーガナイザー", "added", ["team_ops"], 6, null, "機械工学科", "3年"),
    mk("member_o2", "中村", "リーダー", "added", ["team_ops"], 7, null, "経営情報学科", "2年"),
    // スポンサー
    mk("member_s1", "吉岡", "オーガナイザー", "added", ["team_sponsor"], 8, null, "経営情報学科", "3年"),
    mk("member_s2", "前", "リーダー", "added", ["team_sponsor"], 9, null, "情報工学科", "2年"),
    mk("member_s3", "松島", "メンバー", "invited", ["team_sponsor"], 10, null, "電気電子工学科", "1年"),
    // 会場
    mk("member_v1", "清水", "オーガナイザー", "added", ["team_venue"], 11, null, "建築学科", "3年"),
    mk("member_2", "佐藤 花子", "会場リーダー", "added", ["team_venue"], 12, null, "建築学科", "2年"),
    // 集客広報
    mk("member_e1", "白木", "オーガナイザー", "added", ["team_pr"], 13, null, "メディア情報学科", "3年"),
    mk("member_e2", "石井", "リーダー", "added", ["team_pr"], 14, null, "メディア情報学科", "2年"),
    mk("member_3", "鈴木 一郎", "広報担当", "invited", ["team_pr"], 15, "ichiro@example.com", "メディア情報学科", "1年"),
    mk("member_5", "山田 三郎", "デザイン", "declined", [], 16),
    // チーム未割り当て(未所属)のメンバー — 「未所属」を擬似チームにせず控えめに扱うUIの確認用。
    mk("member_6", "田村 未", "メンバー", "invited", [], 17, null, "情報工学科", "1年"),
  ];

  // 参加届の回答一覧 (運営専用 GET) が返す提出済みレコード。submit のたびに push され、
  // ここに seed した 2 件で初回から一覧に中身が見える (実ブラウザ E2E 用)。
  const participations: any[] = [
    {
      id: "part_seed_1", orgId: ORG, memberId: "member_h2", name: "黒川", normalizedName: "黒川",
      lastName: "黒川", firstName: null, nameKana: "くろかわ", lastNameKana: "くろかわ", firstNameKana: null,
      nameRomaji: "Kurokawa", lastNameRomaji: "Kurokawa", firstNameRomaji: null,
      grade: "3", department: "情報工学科", contact: "kurokawa@school.ac.jp", phone: "090-1111-2222",
      schoolEmail: "kurokawa@school.ac.jp", gmail: "kurokawa.dev@gmail.com", desiredTeamId: "team_hq",
      desiredActivity: "both", note: "統括の手伝いをしたいです。", status: "submitted",
      matchKind: "linked_existing", submittedBy: ME_ID, submittedAt: isoNow(), createdAt: isoNow(), updatedAt: isoNow(),
    },
    {
      id: "part_seed_2", orgId: ORG, memberId: "member_demo_new", name: "田中 実", normalizedName: "田中実",
      lastName: "田中", firstName: "実", nameKana: "たなか みのる", lastNameKana: "たなか", firstNameKana: "みのる",
      nameRomaji: "Tanaka Minoru", lastNameRomaji: "Tanaka", firstNameRomaji: "Minoru",
      grade: "2", department: "電気電子工学科", contact: "tanaka@school.ac.jp", phone: "080-3333-4444",
      schoolEmail: "tanaka@school.ac.jp", gmail: "tanaka.minoru@gmail.com", desiredTeamId: "team_pr",
      desiredActivity: "event", note: null, status: "submitted",
      matchKind: "created_new", submittedBy: ME_ID, submittedAt: isoNow(), createdAt: isoNow(), updatedAt: isoNow(),
    },
  ];

  const overview = () => json({ teams: teams.map((t) => ({ ...t })), members: members.map((m) => ({ ...m, teamIds: [...m.teamIds] })) });

  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  function handle(method: string, pathname: string, _url: URL, body: any): Response | null {
    if (method === "GET" && pathname === "/api/v1/members/overview") return overview();
    // canonical team list other apps read
    if (method === "GET" && pathname === "/api/v1/members/teams") return json({ teams: teams.map((t) => ({ ...t })) });

    // teams
    if (method === "POST" && pathname === "/api/v1/members/teams") {
      const name = String(body?.name ?? "");
      const t: DemoTeam = { id: nid("team"), key: slug(body?.key ?? name) || `team-${teams.length + 1}`, name, color: body?.color ?? null, description: body?.description ?? null };
      teams.push(t);
      return json(t, 201);
    }
    let m = /^\/api\/v1\/members\/teams\/([^/]+)$/.exec(pathname);
    if (m) {
      const t = teams.find((x) => x.id === decodeURIComponent(m![1]!));
      if (!t) return notFound(`${method} ${pathname}`);
      if (method === "PATCH") {
        if (body?.name !== undefined) t.name = String(body.name);
        if (body?.key !== undefined) t.key = slug(body.key) || t.key;
        if (body?.color !== undefined) t.color = body.color ?? null;
        if (body?.description !== undefined) t.description = body.description ?? null;
        return json(t);
      }
      if (method === "DELETE") {
        teams.splice(teams.indexOf(t), 1);
        for (const mem of members) mem.teamIds = mem.teamIds.filter((id) => id !== t.id);
        return json({ ok: true });
      }
    }

    // people
    if (method === "POST" && pathname === "/api/v1/members/people") {
      const mem: DemoMember = {
        id: nid("member"), orgId: ORG, name: String(body?.name ?? ""), roleTitle: body?.roleTitle ?? null,
        status: body?.status ?? "considering", teamIds: Array.isArray(body?.teamIds) ? [...body.teamIds] : [],
        department: body?.department ?? null, grade: body?.grade ?? null,
        identityUserId: null,
        contact: body?.contact ?? null, schoolEmail: null, gmail: null,
        lastName: null, firstName: null, lastNameKana: null, firstNameKana: null, lastNameRomaji: null, firstNameRomaji: null, phone: null, note: body?.note ?? null,
        sortOrder: (members.length + 1) * 1024, version: 1,
        createdAt: isoNow(), updatedAt: isoNow(),
      };
      members.push(mem);
      return json(mem, 201);
    }
    // reverse lookup: member linked to an identity user (offboarding fan-out, #1/#2).
    m = /^\/api\/v1\/members\/people\/by-identity\/([^/]+)$/.exec(pathname);
    if (m && method === "GET") {
      const iid = decodeURIComponent(m[1]!);
      const mem = members.find((x) => x.identityUserId === iid);
      return json({ member: mem ? { ...mem, teamIds: [...mem.teamIds] } : null });
    }
    // link / unlink to an identity account (#1).
    m = /^\/api\/v1\/members\/people\/([^/]+)\/identity-link$/.exec(pathname);
    if (m && method === "POST") {
      const mem = members.find((x) => x.id === decodeURIComponent(m![1]!));
      if (!mem) return notFound(`${method} ${pathname}`);
      if (typeof body?.version === "number" && body.version !== mem.version) {
        const err: ErrorResponse = { error: { code: "MEMBER_VERSION_CONFLICT", message: "version conflict", retryable: false } };
        return json(err, 409);
      }
      const target = body?.identityUserId ?? null;
      if (target !== null && members.some((x) => x.id !== mem.id && x.identityUserId === target)) {
        const err: ErrorResponse = { error: { code: "MEMBER_IDENTITY_ALREADY_LINKED", message: "この account は既に別のメンバーに紐付いています", retryable: false } };
        return json(err, 409);
      }
      mem.identityUserId = target;
      mem.version += 1;
      mem.updatedAt = isoNow();
      return json({ ...mem, teamIds: [...mem.teamIds] });
    }
    m = /^\/api\/v1\/members\/people\/([^/]+)$/.exec(pathname);
    if (m) {
      const mem = members.find((x) => x.id === decodeURIComponent(m![1]!));
      if (!mem) return notFound(`${method} ${pathname}`);
      if (method === "PATCH") {
        if (typeof body?.version === "number" && body.version !== mem.version) {
          const err: ErrorResponse = { error: { code: "MEMBER_VERSION_CONFLICT", message: "version conflict", retryable: false } };
          return json(err, 409);
        }
        if (body?.name !== undefined) mem.name = String(body.name);
        if (body?.roleTitle !== undefined) mem.roleTitle = body.roleTitle ?? null;
        if (body?.status !== undefined) mem.status = body.status;
        if (body?.teamIds !== undefined) mem.teamIds = Array.isArray(body.teamIds) ? [...body.teamIds] : [];
        if (body?.department !== undefined) mem.department = body.department ?? null;
        if (body?.grade !== undefined) mem.grade = body.grade ?? null;
        if (body?.identityUserId !== undefined) mem.identityUserId = body.identityUserId ?? null;
        if (body?.contact !== undefined) mem.contact = body.contact ?? null;
        if (body?.note !== undefined) mem.note = body.note ?? null;
        if (typeof body?.sortOrder === "number") mem.sortOrder = body.sortOrder;
        mem.version += 1;
        mem.updatedAt = isoNow();
        return json({ ...mem, teamIds: [...mem.teamIds] });
      }
      if (method === "DELETE") {
        members.splice(members.indexOf(mem), 1);
        return json({ ok: true });
      }
    }

    // 参加届 (participation): submit reflects onto the roster exactly like member-service
    // — name match (space/width-folded) promotes 招待中/検討中 → 追加済 (merging the desired
    // team, non-destructive contact + the two emails), else creates a new 追加済 member.
    // Both endpoints share this reflect: the PUBLIC one (unauthenticated) returns a minimal
    // { accepted, matchKind }; the authenticated one returns the full participation + member.
    const reflectParticipation = (): { participation: unknown; member: DemoMember; matchKind: "linked_existing" | "created_new" } => {
      const compose = (a: unknown, b: unknown): string =>
        [a, b].map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x.length > 0).join(" ");
      const lastName: string | null = body?.lastName ?? null;
      const firstName: string | null = body?.firstName ?? null;
      const lastNameKana: string | null = body?.lastNameKana ?? null;
      const firstNameKana: string | null = body?.firstNameKana ?? null;
      const lastNameRomaji: string | null = body?.lastNameRomaji ?? null;
      const firstNameRomaji: string | null = body?.firstNameRomaji ?? null;
      // 分割入力を優先し "姓 名" を合成。旧単一 name も後方互換で受ける。
      const name = (compose(lastName, firstName) || String(body?.name ?? "")).trim();
      const nameKana: string | null = compose(lastNameKana, firstNameKana) || body?.nameKana || null;
      const nameRomaji: string | null = compose(lastNameRomaji, firstNameRomaji) || body?.nameRomaji || null;
      const phone: string | null = body?.phone ?? null;
      const norm = (s: string): string => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
      const target = norm(name);
      const desiredTeamId: string | null = body?.desiredTeamId ?? null;
      const contact: string | null = body?.contact ?? null;
      const schoolEmail: string = String(body?.schoolEmail ?? "");
      const gmail: string = String(body?.gmail ?? "");
      const note: string | null = body?.note ?? null;
      const department: string | null = body?.department ?? null;
      const grade: string | null = body?.grade ?? null;
      const existing = members.find((mem) => norm(mem.name) === target);
      let matchKind: "linked_existing" | "created_new";
      let resolved: DemoMember;
      if (existing) {
        if (existing.status === "invited" || existing.status === "considering") existing.status = "added";
        if (desiredTeamId && !existing.teamIds.includes(desiredTeamId)) existing.teamIds.push(desiredTeamId);
        if (existing.contact === null) existing.contact = contact ?? schoolEmail;
        if (existing.department === null && department) existing.department = department;
        if (existing.grade === null && grade) existing.grade = grade;
        if (existing.schoolEmail === null && schoolEmail) existing.schoolEmail = schoolEmail;
        if (existing.gmail === null && gmail) existing.gmail = gmail;
        if (existing.lastName === null && lastName) existing.lastName = lastName;
        if (existing.firstName === null && firstName) existing.firstName = firstName;
        if (existing.lastNameKana === null && lastNameKana) existing.lastNameKana = lastNameKana;
        if (existing.firstNameKana === null && firstNameKana) existing.firstNameKana = firstNameKana;
        if (existing.lastNameRomaji === null && lastNameRomaji) existing.lastNameRomaji = lastNameRomaji;
        if (existing.firstNameRomaji === null && firstNameRomaji) existing.firstNameRomaji = firstNameRomaji;
        if (existing.phone === null && phone) existing.phone = phone;
        if (existing.note === null && note) existing.note = note;
        existing.version += 1;
        existing.updatedAt = isoNow();
        resolved = existing;
        matchKind = "linked_existing";
      } else {
        resolved = {
          id: nid("member"), orgId: ORG, name, roleTitle: null, status: "added", identityUserId: null,
          department, grade,
          teamIds: desiredTeamId ? [desiredTeamId] : [], contact: contact ?? schoolEmail,
          schoolEmail: schoolEmail || null, gmail: gmail || null,
          lastName, firstName, lastNameKana, firstNameKana, lastNameRomaji, firstNameRomaji, phone, note,
          sortOrder: (members.length + 1) * 1024, version: 1, createdAt: isoNow(), updatedAt: isoNow(),
        };
        members.push(resolved);
        matchKind = "created_new";
      }
      const participation = {
        id: nid("part"), orgId: ORG, memberId: resolved.id, name, normalizedName: target,
        lastName, firstName, nameKana, lastNameKana, firstNameKana,
        nameRomaji, lastNameRomaji, firstNameRomaji,
        grade: body?.grade ?? null, department: body?.department ?? null,
        contact, phone, schoolEmail, gmail, desiredTeamId, desiredActivity: body?.desiredActivity ?? null, note,
        status: "submitted", matchKind, submittedBy: ME_ID, submittedAt: isoNow(), createdAt: isoNow(), updatedAt: isoNow(),
      };
      participations.unshift(participation);
      return { participation, member: resolved, matchKind };
    };

    // PUBLIC (unauthenticated) submit — the form posts here. Minimal response (no member echo).
    if (method === "POST" && pathname === "/api/v1/public/participation") {
      const school = String(body?.schoolEmail ?? "").trim();
      const gm = String(body?.gmail ?? "").trim();
      const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      // 姓/名 の分割入力 or 旧単一 name のどちらかで氏名が揃えば OK。
      const composedName = [body?.lastName, body?.firstName]
        .map((x) => (typeof x === "string" ? x.trim() : ""))
        .filter((x) => x.length > 0)
        .join(" ");
      const hasName = composedName.length > 0 || String(body?.name ?? "").trim().length > 0;
      if (!hasName || !emailRe.test(school) || !emailRe.test(gm)) {
        const err: ErrorResponse = { error: { code: "VALIDATION_FAILED", message: "invalid", retryable: false } };
        return json(err, 400);
      }
      const { matchKind } = reflectParticipation();
      return json({ accepted: true, matchKind }, 200);
    }

    // Authenticated submit (back-compat): full participation + member echo.
    if (method === "POST" && pathname === "/api/v1/members/participation") {
      const { participation, member, matchKind } = reflectParticipation();
      return json({ participation, member: { ...member, teamIds: [...member.teamIds] }, matchKind }, 201);
    }

    // 運営専用の回答一覧 (identity:read はデモでは全許可)。最新順で返す。
    if (method === "GET" && pathname === "/api/v1/members/participation") {
      return json({ participations: participations.map((p) => ({ ...p })) });
    }

    return null;
  }

  return { handle };
}

/** A `fetch` that serves the demo feature surface, delegating boot + unknown
 *  routes to the offline boot mock. Feed to createApiClient({ fetchImpl }). */
export function createDemoFetch(): typeof fetch {
  const boot = createMockFetch({
    me: DEMO_ME,
    home: {
      upcomingEvents: EVENTS.slice(0, 2),
      unreadCount: NOTIFICATIONS.filter((n) => n.readAt === null).length,
      // Task breakdown derived from the seeded task list (same shape the gateway BFF
      // aggregates from task-service), so the demo dashboard reads like live data.
      taskSummary: {
        total: TASKS.length,
        byStatus: TASKS.reduce(
          (acc, t) => {
            acc[t.status] += 1;
            return acc;
          },
          { todo: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0 } as Record<task.TaskStatus, number>,
        ),
      },
      // Illustrative free-tier snapshot (same projection the BFF derives from usage-meter).
      usageSummary: {
        metrics: [
          { key: "kv_reads_day", label: "KV 読み取り(日)", pct: 58.2 },
          { key: "d1_rows_read_day", label: "D1 行読み取り(日)", pct: 41.0 },
          { key: "workers_requests_day", label: "Workers リクエスト(日)", pct: 9.4 },
          { key: "emails_month", label: "メール送信(月)", pct: 22.5 },
        ],
        worst: { key: "kv_reads_day", label: "KV 読み取り(日)", pct: 58.2 },
      },
      // 運営メンバー / チーム — matches the seeded roster below (6 teams, 17 members).
      orgStats: { members: 17, teams: 6 },
      partialErrors: [],
    },
  });
  // Mutable roster state for the interactive admin console (create/edit/assign).
  const roster = createRosterStore();
  // Mutable Inbox + Sent folders (read-state persists; a demo send lands in Sent).
  const mailStore = createMailStore();
  // Mutable Hackit Drive sharing state (grant/change/revoke/link toggle persist).
  const driveShareStore = createDriveShareStore();
  // Mutable 運営メンバー store (teams + members CRUD persists for the session).
  const membersStore = createMembersStore();
  // Read-mostly chat channel set (全体 / チーム別 / 役割別) for the sidebar.
  const chatStore = createChatStore();

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
    // /me reflects the ACTIVE demo account (localStorage-selected) so switching accounts
    // and reloading re-scopes the whole shell — the header title, permissions and mail.
    if (method === "GET" && url.pathname === "/api/v1/me") return json(currentMe());

    const hit =
      roster.handle(method, url.pathname, url, parsedBody) ??
      mailStore.handle(method, url.pathname, url, parsedBody) ??
      driveShareStore.handle(method, url.pathname, url, parsedBody) ??
      membersStore.handle(method, url.pathname, url, parsedBody) ??
      chatStore.handle(method, url.pathname, url, parsedBody) ??
      matchDemoRoute(method, url.pathname, url, parsedBody);
    if (hit) return hit;
    // Boot surface (/bff/home, /auth/*) + NOT_FOUND for everything else.
    return boot(input, init);
  };

  return demoFetch as unknown as typeof fetch;
}

/** True when the shell should boot the demo transport (VITE_DEMO=1 / true). */
export function isDemoEnabled(env: { VITE_DEMO?: string } | undefined): boolean {
  return env?.VITE_DEMO === "true" || env?.VITE_DEMO === "1";
}
