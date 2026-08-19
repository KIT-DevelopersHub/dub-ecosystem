// In-memory mock ApiClient for FE5 dev + tests. Implements the notification
// gateway surface against seed data. Throws ApiError-shaped errors so FE5's
// error handling (rollback / 404-drop) can be exercised without FE2.

import { common } from "@dub/types";
import type { ApiClient, ApiError } from "../contracts/fe2";
import type {
  AdminNotificationItem,
  GetPreferencesResponse,
  InboxItem,
  ListAdminNotificationsResponse,
  ListInboxResponse,
  PreferenceEntry,
  PublishBroadcastResponse,
  PublishBroadcastBatchItem,
  PublishBroadcastBatchResponse,
  UnpublishBroadcastResponse,
  UnpublishBroadcastBatchItem,
  UnpublishBroadcastBatchResponse,
  ReadAllRequest,
  UnreadCountResponse,
  UpdatePreferencesRequest,
} from "../contracts/notification-api";

export type MockViewer = "admin" | "member";

const BASE = `${common.API_PREFIX}/notifications`;

// Default preferences (display-only initial constant; FE5 §2-2 / theme4).
// in_app = on for all types / email = urgent-only / chat = off / push = on.
export const DEFAULT_PREFERENCES: PreferenceEntry[] = [
  { type: "*", channels: ["in_app", "push"] },
  { type: "task.*", channels: ["in_app", "push"] },
  { type: "task.due_soon", channels: ["in_app", "email", "push"] }, // urgent -> email on
  { type: "event.*", channels: ["in_app", "push"] },
  { type: "system.announcement", channels: ["in_app"] }, // in_app forced, no push
  { type: "release", channels: ["in_app"] }, // release notes: in_app forced (new-feature 🎉)
  // chat.* is intentionally absent -> chat inbox transcription off (test 18).
];

export class MockApiError extends Error implements ApiError {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: unknown;
  constructor(code: string, status: number, message: string, retryable = false) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.requestId = "req_mock_0001";
  }
}

export interface MockSeed {
  items?: InboxItem[];
  overrides?: PreferenceEntry[];
  adminItems?: AdminNotificationItem[];
  // Which audience the signed-in viewer represents (admin sees both audiences; a
  // member is filtered to audience='members'). Default "admin".
  viewer?: MockViewer;
  pageSize?: number;
  // Force the next matching call to fail (for testing rollback paths).
  failNext?: { pathIncludes: string; error: MockApiError };
}

// Admin notifications seed (audience='admin') powering the management screen. Mirrors the
// three auto-admin notification kinds (deploy done / feature published / feedback).
function seedAdminItems(): AdminNotificationItem[] {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const mk = (n: number, type: string, title: string, body: string): AdminNotificationItem => ({
    id: `ntfn_adm_${String(n).padStart(4, "0")}`,
    type,
    title,
    body,
    audience: "admin",
    createdAt: iso(n * 60_000),
    publishedBroadcastId: null,
  });
  return [
    mk(1, "deploy.deployment.status_changed", "デプロイ完了: dub-ecosystem", "本番へのデプロイが完了しました。"),
    mk(2, "release", "🎉 ガントチャートをメンバー公開しました", "タスクの期間・進捗・依存をタイムラインで確認できます。"),
    mk(3, "feedback", "新しいフィードバック: 検索が遅い", "カテゴリ: idea\n送信ユーザー: usr_alice\n\n検索ページが重いです"),
  ];
}

function seedItems(): InboxItem[] {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const mk = (
    n: number,
    type: string,
    title: string,
    read: boolean,
    resource?: { type: string; id: string },
  ): InboxItem => ({
    id: `notif_${String(n).padStart(4, "0")}`,
    type,
    title,
    body: `${title} — details for item ${n}.`,
    readAt: read ? iso(n * 3600_000) : null,
    createdAt: iso(n * 60_000),
    resourceType: resource?.type ?? null,
    resourceId: resource?.id ?? null,
    audience: "members",
  });
  return [
    // Release notes surface at the top of the inbox so the "🎉 新機能" badge is visible.
    // Seeded as read so the default unread count is unchanged; publishing via the admin
    // form (or the seed route) produces fresh unread release notes.
    mk(7, "release", "🎉 ガントチャート（Notion風）を追加しました", true),
    mk(8, "release", "🎉 メールにファイルを添付できるようになりました", true),
    mk(1, "task.assigned", "You were assigned “Ship FE5”", false, { type: "task", id: "task_ship_fe5" }),
    mk(2, "task.due_soon", "“Design review” is due soon", false, { type: "task", id: "task_design" }),
    mk(3, "event.invited", "Invited to “北陸ITカンファレンス”", false, { type: "event", id: "event_hokuriku" }),
    mk(4, "system.announcement", "Scheduled maintenance tonight", true),
    mk(5, "task.completed", "“Write tests” was completed", true, { type: "task", id: "task_tests" }),
    mk(6, "event.reminder", "Standup in 10 minutes", true, { type: "event", id: "event_standup" }),
    // メール (mail) category — inbound mail relayed by mail-gateway. Seeded read so the default
    // unread count is unchanged; the item still populates the "メール" tab for the demo.
    mk(9, "mail.message.received", "新着メール: 参加者からのお問い合わせ", true, {
      type: "mail_message",
      id: "mail_0001",
    }),
    // 参加届 (participation) category — a 参加届 submission notified to admins (#326).
    mk(10, "member.participation.submitted", "新しい参加届: 山田 太郎", true, {
      type: "participation",
      id: "part_0001",
    }),
  ];
}

// Create a mock ApiClient. Mutations mutate the in-memory store so polling /
// re-fetch reflect changes.
export function createMockApiClient(seed: MockSeed = {}): ApiClient & {
  __store: {
    items: InboxItem[];
    overrides: PreferenceEntry[];
    adminItems: AdminNotificationItem[];
    viewer: MockViewer;
  };
  __setViewer(v: MockViewer): void;
} {
  const store = {
    items: seed.items ? [...seed.items] : seedItems(),
    overrides: seed.overrides ? [...seed.overrides] : [],
    adminItems: seed.adminItems ? [...seed.adminItems] : seedAdminItems(),
    viewer: seed.viewer ?? ("admin" as MockViewer),
  };
  const pageSize = seed.pageSize ?? 50;
  let failNext = seed.failNext;

  // A member viewer is filtered to audience='members'; an admin sees everything.
  const visibleItems = (): InboxItem[] =>
    store.viewer === "admin" ? store.items : store.items.filter((i) => i.audience !== "admin");

  // Publish one admin notification to members (idempotent). Throws MockApiError on an
  // unknown id. Shared by the single + batch endpoints so their behaviour is identical.
  const publishOne = (id: string): PublishBroadcastResponse => {
    const admin = store.adminItems.find((a) => a.id === id);
    if (!admin) throw new MockApiError("NOTIF_NOTIFICATION_NOT_FOUND", 404, `notification not found: ${id}`);
    if (admin.publishedBroadcastId) {
      return { notificationId: admin.publishedBroadcastId, deduplicated: true, publishedBroadcastId: admin.publishedBroadcastId };
    }
    const broadcastId = `ntfn_bc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    admin.publishedBroadcastId = broadcastId;
    store.items.unshift({
      id: broadcastId,
      type: "system.announcement",
      title: admin.title,
      body: admin.body,
      readAt: null,
      createdAt: new Date().toISOString(),
      resourceType: "notification",
      resourceId: admin.id,
      audience: "members",
    });
    return { notificationId: broadcastId, deduplicated: false, publishedBroadcastId: broadcastId };
  };

  // Unpublish one admin notification (idempotent). Throws MockApiError on an unknown id.
  // Removes the members broadcast fanned into the inbox store so a member view no longer
  // shows it, and flips the admin row back to publishable. Shared by single + batch.
  const unpublishOne = (id: string): UnpublishBroadcastResponse => {
    const admin = store.adminItems.find((a) => a.id === id);
    if (!admin) throw new MockApiError("NOTIF_NOTIFICATION_NOT_FOUND", 404, `notification not found: ${id}`);
    const broadcastId = admin.publishedBroadcastId;
    if (!broadcastId) return { notificationId: id, retracted: false, removedBroadcastId: null };
    admin.publishedBroadcastId = null;
    // Drop the broadcast row (matched by its resource link back to the source) from the inbox.
    store.items = store.items.filter((i) => !(i.id === broadcastId || (i.resourceType === "notification" && i.resourceId === admin.id)));
    return { notificationId: id, retracted: true, removedBroadcastId: broadcastId };
  };

  const maybeFail = (path: string): void => {
    if (failNext && path.includes(failNext.pathIncludes)) {
      const err = failNext.error;
      failNext = undefined;
      throw err;
    }
  };

  const paginate = (items: InboxItem[], cursor?: string, limit?: number): ListInboxResponse => {
    const size = Math.min(limit ?? pageSize, 200);
    const start = cursor ? Number(cursor) : 0;
    const slice = items.slice(start, start + size);
    const end = start + size;
    return { items: slice, nextCursor: end < items.length ? String(end) : null };
  };

  return {
    __store: store,
    __setViewer(v: MockViewer) {
      store.viewer = v;
    },
    async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
      maybeFail(path);
      if (path === `${BASE}/inbox`) {
        let items = visibleItems();
        if (query?.unreadOnly) items = items.filter((i) => i.readAt === null);
        if (typeof query?.type === "string" && query.type) {
          const prefix = query.type;
          items = items.filter((i) => i.type.startsWith(prefix));
        }
        const cursor = typeof query?.cursor === "string" ? query.cursor : undefined;
        const limit = typeof query?.limit === "number" ? query.limit : undefined;
        return paginate(items, cursor, limit) as T;
      }
      if (path === `${BASE}/inbox/unread-count`) {
        const count = visibleItems().filter((i) => i.readAt === null).length;
        return { count } satisfies UnreadCountResponse as T;
      }
      if (path === `${BASE}/preferences`) {
        return {
          defaults: DEFAULT_PREFERENCES,
          overrides: store.overrides,
        } satisfies GetPreferencesResponse as T;
      }
      if (path === `${BASE}/manage`) {
        return { items: [...store.adminItems], nextCursor: null } satisfies ListAdminNotificationsResponse as T;
      }
      throw new MockApiError("NOT_FOUND", 404, `No mock GET for ${path}`);
    },

    async post<T>(path: string, body?: unknown): Promise<T> {
      maybeFail(path);
      if (path === `${BASE}/release`) {
        // Admin publish: broadcast a release note. In the mock we just add it to the
        // signed-in user's inbox (unread) so the demo shows the new "🎉 新機能" item.
        const req = (body ?? {}) as { title?: string; body?: string };
        const now = new Date();
        const item: InboxItem = {
          id: `notif_rel_${now.getTime()}`,
          type: "release",
          title: req.title ?? "🎉 新機能",
          body: req.body ?? "",
          readAt: null,
          createdAt: now.toISOString(),
          resourceType: "release",
          resourceId: null,
        };
        store.items.unshift(item);
        return { notificationId: item.id, deduplicated: false } as T;
      }
      if (path === `${BASE}/manage/publish-batch`) {
        const ids = Array.isArray((body as { ids?: unknown })?.ids) ? ((body as { ids: string[] }).ids) : [];
        const seen = new Set<string>();
        const results: PublishBroadcastBatchItem[] = [];
        let publishedCount = 0, deduplicatedCount = 0, failedCount = 0;
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          try {
            const r = publishOne(id);
            results.push({ id, ok: true, deduplicated: r.deduplicated, publishedBroadcastId: r.publishedBroadcastId });
            if (r.deduplicated) deduplicatedCount++; else publishedCount++;
          } catch (e) {
            results.push({ id, ok: false, code: e instanceof MockApiError ? e.code : "NOTIF_PUBLISH_FAILED" });
            failedCount++;
          }
        }
        return { results, publishedCount, deduplicatedCount, failedCount } satisfies PublishBroadcastBatchResponse as T;
      }
      if (path === `${BASE}/manage/unpublish-batch`) {
        const ids = Array.isArray((body as { ids?: unknown })?.ids) ? ((body as { ids: string[] }).ids) : [];
        const seen = new Set<string>();
        const results: UnpublishBroadcastBatchItem[] = [];
        let retractedCount = 0, noopCount = 0, failedCount = 0;
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          try {
            const r = unpublishOne(id);
            const item: UnpublishBroadcastBatchItem = { id, ok: true, retracted: r.retracted };
            if (r.removedBroadcastId) item.removedBroadcastId = r.removedBroadcastId;
            results.push(item);
            if (r.retracted) retractedCount++; else noopCount++;
          } catch (e) {
            results.push({ id, ok: false, code: e instanceof MockApiError ? e.code : "NOTIF_UNPUBLISH_FAILED" });
            failedCount++;
          }
        }
        return { results, retractedCount, noopCount, failedCount } satisfies UnpublishBroadcastBatchResponse as T;
      }
      const unpublishMatch = path.match(new RegExp(`^${BASE}/manage/([^/]+)/unpublish$`));
      if (unpublishMatch) {
        const id = decodeURIComponent(unpublishMatch[1]!);
        return unpublishOne(id) satisfies UnpublishBroadcastResponse as T;
      }
      const publishMatch = path.match(new RegExp(`^${BASE}/manage/([^/]+)/publish$`));
      if (publishMatch) {
        const id = decodeURIComponent(publishMatch[1]!);
        return publishOne(id) satisfies PublishBroadcastResponse as T;
      }
      if (path === `${BASE}/inbox/read-all`) {
        const req = (body ?? {}) as ReadAllRequest;
        const now = new Date().toISOString();
        for (const i of store.items) {
          if (i.readAt === null && (!req.type || i.type.startsWith(req.type))) i.readAt = now;
        }
        return undefined as T;
      }
      throw new MockApiError("NOT_FOUND", 404, `No mock POST for ${path}`);
    },

    async patch<T>(path: string, body?: unknown): Promise<T> {
      maybeFail(path);
      const readMatch = path.match(new RegExp(`^${BASE}/inbox/([^/]+)/read$`));
      if (readMatch) {
        const id = decodeURIComponent(readMatch[1]!);
        const item = store.items.find((i) => i.id === id);
        if (!item) {
          throw new MockApiError("NOTIF_INBOX_ITEM_NOT_FOUND", 404, `Inbox item not found: ${id}`);
        }
        if (item.readAt === null) item.readAt = new Date().toISOString();
        return undefined as T;
      }
      if (path === `${BASE}/preferences`) {
        const req = (body ?? { entries: [] }) as UpdatePreferencesRequest;
        for (const entry of req.entries) {
          const idx = store.overrides.findIndex((o) => o.type === entry.type);
          if (idx >= 0) store.overrides[idx] = { ...entry };
          else store.overrides.push({ ...entry });
        }
        return undefined as T;
      }
      throw new MockApiError("NOT_FOUND", 404, `No mock PATCH for ${path}`);
    },
  };
}
