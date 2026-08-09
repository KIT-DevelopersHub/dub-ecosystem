// api-client — MO3 `/m/v1/*` client (design §2-2 ApiClient module). Owns the
// three cross-cutting behaviours the Swift ApiClient must match exactly:
//   1. Bearer attach from the Keychain-backed TokenStore.
//   2. 401 -> single silent refresh -> retry ONCE (design §6, test §7 "1回性").
//   3. ErrorResponse -> semi-open DubClientError + retryable backoff (max 2).
// Contract types come from @dub/types `mobile`/`task`/`event`/`notification`
// namespaces (MO3 正本); this layer never re-defines them.
import {
  common,
  type auth,
  type chat,
  type event,
  type gantt,
  type mobile,
  type notification,
  type task,
} from "@dub/types";
import { CommonErrorCodes, isErrorResponse } from "@dub/errors";
import type { Transport, HttpMethod } from "./transport.js";
import type { TokenStore, StoredSession } from "./token-store.js";
import { fromResponseBody, offlineError, type DubClientError } from "./errors.js";

/**
 * Mobile auth envelope. The MO3 `mobile` namespace has not yet frozen the
 * exchange/refresh RESPONSE shape (only auth.MobileExchangeRequest exists), so
 * this is a client-local view over the frozen auth.SessionInfo — replace with
 * the generated `mobile.MobileAuthSession` once MO3 publishes it (see notes).
 */
export interface MobileAuthSession {
  token: string;
  session: auth.SessionInfo;
}

export interface ApiClientConfig {
  /** origin of m-api.developershub.jp, e.g. "https://m-api.developershub.jp". */
  baseUrl: string;
  transport: Transport;
  tokenStore: TokenStore;
  /** max retryable-error retries (default 2, design §6). */
  maxRetries?: number;
  /** injectable delay so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
  /** called after refresh fails / retry still 401: UI routes to S1 login. */
  onSessionExpired?: () => void;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** skip the Bearer header + 401-refresh dance (auth exchange/refresh/login). */
  anonymous?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MobileApiClient {
  readonly #cfg: Required<Omit<ApiClientConfig, "onSessionExpired">> & Pick<ApiClientConfig, "onSessionExpired">;
  /** de-dupes concurrent 401s into a single in-flight refresh. */
  #refreshInFlight: Promise<boolean> | null = null;

  constructor(cfg: ApiClientConfig) {
    this.#cfg = {
      maxRetries: 2,
      sleep: defaultSleep,
      ...cfg,
    };
  }

  // ---- typed endpoint wrappers (design §2-1) --------------------------------

  exchange(req: auth.MobileExchangeRequest): Promise<MobileAuthSession> {
    return this.#request<MobileAuthSession>("POST", "/auth/exchange", { body: req, anonymous: true });
  }

  logout(): Promise<void> {
    const session = this.#cfg.tokenStore.read();
    const p = this.#request<null>("POST", "/auth/logout", { body: {} }).then(() => undefined);
    // logout always clears local state regardless of server outcome.
    return p.catch(() => undefined).finally(() => {
      if (session) this.#cfg.tokenStore.clear();
    });
  }

  getHome(): Promise<mobile.MobileHomeResponse> {
    return this.#request<mobile.MobileHomeResponse>("GET", "/bff/home");
  }

  getEventOverview(eventId: string): Promise<mobile.MobileEventOverviewResponse> {
    return this.#request<mobile.MobileEventOverviewResponse>("GET", `/events/${encodeURIComponent(eventId)}`);
  }

  listTasks(query: task.ListTasksQuery = {}): Promise<task.ListTasksResponse> {
    return this.#request<task.ListTasksResponse>("GET", "/tasks", {
      query: {
        cursor: query.cursor,
        limit: query.limit,
        eventId: query.eventId,
        assigneeId: query.assigneeId,
      },
    });
  }

  patchTask(id: string, req: task.UpdateTaskRequest): Promise<task.Task> {
    return this.#request<task.Task>("PATCH", `/tasks/${encodeURIComponent(id)}`, { body: req });
  }

  getInbox(query: notification.ListInboxQuery = {}): Promise<notification.ListInboxResponse> {
    return this.#request<notification.ListInboxResponse>("GET", "/inbox", {
      query: { cursor: query.cursor, limit: query.limit },
    });
  }

  /** S6 gantt chart read: rows + FS dependency lines for one event. */
  getGantt(query: gantt.GetGanttQuery): Promise<gantt.GanttChartDTO> {
    return this.#request<gantt.GanttChartDTO>("GET", "/gantt", {
      query: { eventId: query.eventId },
    });
  }

  /** S8 chat: list the channels the caller can see. */
  listChatChannels(query: common.CursorQuery = {}): Promise<common.Paginated<chat.ChatChannel>> {
    return this.#request<common.Paginated<chat.ChatChannel>>("GET", "/chat/channels", {
      query: { cursor: query.cursor, limit: query.limit },
    });
  }

  /** S8 chat: page a channel's message history (oldest resolved via cursor). */
  listChatMessages(
    channelId: string,
    query: common.CursorQuery = {},
  ): Promise<common.Paginated<chat.ChatMessage>> {
    return this.#request<common.Paginated<chat.ChatMessage>>(
      "GET",
      `/chat/channels/${encodeURIComponent(channelId)}/messages`,
      { query: { cursor: query.cursor, limit: query.limit } },
    );
  }

  /** S8 chat: short-lived ticket for the DO-direct (gateway-bypassing) WS. */
  getChatWsTicket(channelId: string): Promise<chat.WsTicketResponse> {
    return this.#request<chat.WsTicketResponse>(
      "GET",
      `/chat/channels/${encodeURIComponent(channelId)}/ws-ticket`,
    );
  }

  registerDevice(req: mobile.RegisterDeviceRequest): Promise<mobile.RegisterDeviceResponse> {
    return this.#request<mobile.RegisterDeviceResponse>("POST", "/devices", { body: req });
  }

  deleteDevice(deviceId: string): Promise<void> {
    return this.#request<null>("DELETE", `/devices/${encodeURIComponent(deviceId)}`).then(() => undefined);
  }

  // ---- core ----------------------------------------------------------------

  async #request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.#buildUrl(path, opts.query);
    let attempt = 0;
    let refreshedOnce = false;

    for (;;) {
      let res;
      try {
        res = await this.#cfg.transport({
          method,
          url,
          headers: this.#headers(opts.anonymous ?? false),
          ...(opts.body !== undefined ? { body: opts.body } : {}),
        });
      } catch (cause) {
        // transport failure = offline; retry within budget then surface.
        if (attempt < this.#cfg.maxRetries) {
          await this.#backoff(attempt++);
          continue;
        }
        throw offlineError(cause);
      }

      if (res.status >= 200 && res.status < 300) {
        return res.body as T;
      }

      const err = fromResponseBody(res.status, res.body);

      // 401 -> one silent refresh -> retry once (only on authenticated calls).
      if (err.kind === "reauth" && !opts.anonymous) {
        if (!refreshedOnce) {
          refreshedOnce = true;
          const ok = await this.#ensureRefreshed();
          if (ok) continue; // retry with the new token
        }
        // refresh failed, or the retry still 401 -> session is unusable.
        this.#cfg.tokenStore.clear();
        this.#cfg.onSessionExpired?.();
        throw err;
      }

      // retryable upstream / rate-limit -> exponential backoff (Retry-After wins).
      if (err.retryable && attempt < this.#cfg.maxRetries) {
        await this.#backoff(attempt++, err.retryAfterSec);
        continue;
      }

      throw err;
    }
  }

  /** Single-flight refresh: many concurrent 401s share one refresh call. */
  #ensureRefreshed(): Promise<boolean> {
    if (this.#refreshInFlight) return this.#refreshInFlight;
    const p = this.#doRefresh().finally(() => {
      this.#refreshInFlight = null;
    });
    this.#refreshInFlight = p;
    return p;
  }

  async #doRefresh(): Promise<boolean> {
    const current = this.#cfg.tokenStore.read();
    if (!current) return false;
    let res;
    try {
      res = await this.#cfg.transport({
        method: "POST",
        url: this.#buildUrl("/auth/refresh"),
        // Bearer path (theme8): current token is the refresh credential.
        headers: { ...this.#jsonHeaders(), authorization: `Bearer ${current.token}` },
        body: {} satisfies auth.AuthRefreshRequest,
      });
    } catch {
      return false;
    }
    if (res.status < 200 || res.status >= 300) return false;
    if (!isMobileAuthSession(res.body)) return false;
    const next: StoredSession = {
      token: res.body.token,
      sessionExpiresAt: res.body.session.sessionExpiresAt,
    };
    this.#cfg.tokenStore.write(next);
    return true;
  }

  #buildUrl(path: string, query?: RequestOptions["query"]): string {
    const base = this.#cfg.baseUrl.replace(/\/+$/, "");
    let url = `${base}${common.MOBILE_API_PREFIX}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    return url;
  }

  #jsonHeaders(): Record<string, string> {
    return { "content-type": "application/json", accept: "application/json" };
  }

  #headers(anonymous: boolean): Record<string, string> {
    const h = this.#jsonHeaders();
    if (!anonymous) {
      const s = this.#cfg.tokenStore.read();
      if (s) h.authorization = `Bearer ${s.token}`;
    }
    return h;
  }

  async #backoff(attempt: number, retryAfterSec?: number): Promise<void> {
    const ms = retryAfterSec !== undefined ? retryAfterSec * 1000 : 2 ** attempt * 200;
    await this.#cfg.sleep(ms);
  }
}

function isMobileAuthSession(v: unknown): v is MobileAuthSession {
  if (v === null || typeof v !== "object") return false;
  const o = v as { token?: unknown; session?: unknown };
  if (typeof o.token !== "string") return false;
  if (o.session === null || typeof o.session !== "object") return false;
  const s = o.session as { sessionExpiresAt?: unknown };
  return typeof s.sessionExpiresAt === "number";
}

/** Re-export for callers that want to narrow thrown errors. */
export type { DubClientError };
export { isErrorResponse, CommonErrorCodes };
