// notification service constants. Centralized so retention windows and delivery
// retry budget stay in one place (they cross the app / queue / cron boundaries).

export const SERVICE_NAME = "notification";

// Frozen system-default mailbox for outbound email (design §2). SendMailRequest
// carries no mailbox field in the frozen contract, so this rides as an app constant
// only (used for the EmailAdapter idempotency namespace / future From selection).
export const DEFAULT_MAILBOX = "info";

// Per-(user,channel) delivery attempt budget before the delivery is marked failed
// and a delivery-failed audit record is emitted (design test #13).
export const MAX_DELIVERY_ATTEMPTS = 3;

// Retention windows (days) — purged by the daily scheduled handler (design §3).
export const INBOX_RETENTION_DAYS = 90;
export const DELIVERIES_RETENTION_DAYS = 30;
export const PROCESSED_EVENTS_RETENTION_DAYS = 7;

// Validation limits.
export const TITLE_MIN = 1;
export const TITLE_MAX = 200;
export const MAX_DIRECT_RECIPIENTS = 1000;

// Paging (common.CursorQuery: default 50 / max 200).
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;

// The 4 frozen channels (theme4). slack is intentionally excluded.
export const CHANNELS = ["in_app", "email", "chat", "push"] as const;

// Broadcast (org-wide) notification types. Two invariants ride on this list:
//   1) forced into every recipient's in_app inbox at publish time regardless of prefs
//      (design §3 — nobody misses a release / system announcement), and
//   2) lazily backfilled on inbox read (repo.backfillBroadcastInbox) so a user created
//      AFTER a broadcast was published (e.g. info@ / admin@ individualized later) still
//      sees it — fan-out is write-time only, so late joiners would otherwise miss them.
export const BROADCAST_IN_APP_TYPES = ["system.announcement", "release"] as const;

// ---- audience gating (Notification management) ----
// Every notification carries an audience (@dub/types NotificationAudience). The DB
// column defaults to 'members' so every pre-existing / direct notification stays visible
// to the user it targets; the admin-facing update notifications (feedback / deploy / ops
// alerts) explicitly ride as 'admin' and are only visible to admins until published.
export const AUDIENCE_ADMIN = "admin" as const;
export const AUDIENCE_MEMBERS = "members" as const;
export const DEFAULT_AUDIENCE = AUDIENCE_MEMBERS;

// Permission gate for the "publish to members" action (POST /manage/:id/publish) and the
// admin notification list (GET /manage). Held by admin (all catalog keys) + maintainer.
export const BROADCAST_PUBLISH_PERMISSION = "notif:broadcast_publish" as const;
// "admin viewer" gate for inbox audience filtering: holders see BOTH audiences. Members
// (who lack it) are filtered to audience='members' rows only.
export const ADMIN_VIEWER_PERMISSION = "notif:admin" as const;

// The type a member broadcast is published under. Reuses the existing broadcast machinery
// (forced in_app + late-join backfill) so every member — including late joiners — sees it.
export const MEMBER_BROADCAST_TYPE = "system.announcement";
// dedup-key prefix that links a members broadcast back to its source admin notification.
// `broadcast:from:<sourceId>` makes publishing idempotent and lets the admin list detect
// the "already published" state via a self-join.
export const BROADCAST_FROM_PREFIX = "broadcast:from:";

// ---- in-app feedback (widget -> admin) ----
// Closed category vocabulary (mirrors notification.FeedbackCategory).
export const FEEDBACK_CATEGORIES = ["bug", "idea", "question", "other"] as const;
export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_PAGE_URL_MAX = 2048;
export const FEEDBACK_PAGE_NAME_MAX = 200;
// Permission gate for the admin read surface (GET /feedback, PATCH …/read).
export const FEEDBACK_ADMIN_PERMISSION = "notif:admin" as const;
// Best-effort admin notification recipient. Deliverability depends on domain
// verification; a send failure never blocks the feedback save.
export const FEEDBACK_ADMIN_EMAIL = "admin@developershub.jp";
// Excerpt length for the notification subject "フィードバック: <抜粋>".
export const FEEDBACK_EXCERPT_LEN = 60;

// ---- in-app admin notification on feedback submit ----
// On every feedback submit we also create an in-app notification (notifications inbox)
// for each admin / maintainer user, so it shows up in their inbox + unread badge. This
// is a SYNCHRONOUS D1 write via the shared ingest path (in_app channel only), so it
// lands even when the async freeq drain is paused. Slack / chat / email are intentionally
// NOT targeted here — the pre-existing best-effort admin email is untouched.
export const FEEDBACK_NOTIFY_TYPE = "feedback";
// Role IDs mirror the identity-roster system-role seed (identity-roster/src/schema.ts:
// role_sys_admin / role_sys_maintainer). identity `GET /users?roleKey=` filters by roleId.
export const FEEDBACK_NOTIFY_ROLE_IDS = ["role_sys_admin", "role_sys_maintainer"] as const;

// ---- release notes (new-feature announcements) ----
// A release note is broadcast to EVERY active user's inbox as an in_app notification of
// type `release`. FE5 badges it "🎉 新機能". Publishing is admin-gated (POST /release,
// notif:admin); the curated back-catalog below is (re)published idempotently by the
// internal seed route so demo + prod both show the recent releases.
export const RELEASE_NOTIFY_TYPE = "release";
export const RELEASE_ADMIN_PERMISSION = "notif:admin" as const;
export const RELEASE_TITLE_MAX = 200;
export const RELEASE_BODY_MAX = 2000;
export const RELEASE_APP_MAX = 60;

// Curated back-catalog of shipped features, oldest→newest. `key` namespaces the dedup
// key (release:<key>) so re-running the seed never duplicates an inbox item.
export interface ReleaseNoteSeed {
  key: string;
  app: string; // target app / area (optional display); "" = whole product
  title: string;
  body: string;
}
export const INITIAL_RELEASE_NOTES: ReleaseNoteSeed[] = [
  {
    key: "member-roster",
    app: "メンバー管理",
    title: "🎉 メンバー管理が使えるようになりました",
    body: "管理者はメンバー一覧から各ユーザーの表示名・ロールを設定できます。左上のアプリランチャー →「メンバー」から開けます。",
  },
  {
    key: "gantt-notion",
    app: "ガントチャート",
    title: "🎉 ガントチャート（Notion風）を追加しました",
    body: "タスクの期間・進捗・依存関係をタイムラインで一覧できます。バーをドラッグして期間を調整、依存線でブロッカーを可視化します。",
  },
  {
    key: "mail-attachments",
    app: "メール",
    title: "🎉 メールにファイルを添付できるようになりました",
    body: "メール作成画面でファイルを添付して送信できます。受信メールの添付ファイルもその場でプレビュー・ダウンロードできます。",
  },
  {
    key: "usage-dashboard",
    app: "使用量ダッシュボード",
    title: "🎉 無料枠ダッシュボードを全ユーザーに開放しました",
    body: "サインインしている全メンバーが、各サービスの無料枠の使用状況をダッシュボードで確認できるようになりました。",
  },
];
