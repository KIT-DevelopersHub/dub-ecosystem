// In-memory mock ApiClient for FE5 dev + tests. Implements the notification
// gateway surface against seed data. Throws ApiError-shaped errors so FE5's
// error handling (rollback / 404-drop) can be exercised without FE2.

import { common } from "@dub/types";
import type { ApiClient, ApiError } from "../contracts/fe2";
import type {
  GetPreferencesResponse,
  InboxItem,
  ListInboxResponse,
  PreferenceEntry,
  ReadAllRequest,
  UnreadCountResponse,
  UpdatePreferencesRequest,
} from "../contracts/notification-api";

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
  pageSize?: number;
  // Force the next matching call to fail (for testing rollback paths).
  failNext?: { pathIncludes: string; error: MockApiError };
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
  ];
}

// Create a mock ApiClient. Mutations mutate the in-memory store so polling /
// re-fetch reflect changes.
export function createMockApiClient(seed: MockSeed = {}): ApiClient & {
  __store: { items: InboxItem[]; overrides: PreferenceEntry[] };
} {
  const store = {
    items: seed.items ? [...seed.items] : seedItems(),
    overrides: seed.overrides ? [...seed.overrides] : [],
  };
  const pageSize = seed.pageSize ?? 50;
  let failNext = seed.failNext;

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
    async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
      maybeFail(path);
      if (path === `${BASE}/inbox`) {
        let items = store.items;
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
        const count = store.items.filter((i) => i.readAt === null).length;
        return { count } satisfies UnreadCountResponse as T;
      }
      if (path === `${BASE}/preferences`) {
        return {
          defaults: DEFAULT_PREFERENCES,
          overrides: store.overrides,
        } satisfies GetPreferencesResponse as T;
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
