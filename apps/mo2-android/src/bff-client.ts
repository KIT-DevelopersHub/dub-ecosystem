// MobileBffClient — the single network entry point (§1: MO2 knows only MO3).
// All calls hit `/m/v1/*` on m-api.developershub.jp. Auth-guarded calls run
// through AuthInterceptor (401 -> refresh once); auth/exchange|refresh do not.
import type { FetchFn } from "./http";
import { HttpTransport } from "./http";
import { AuthInterceptor } from "./auth-interceptor";
import type { SessionStore } from "./session-store";
import { MOBILE_PLATFORM } from "./config";
import type {
  MobileHomeResponse,
  MobileEventOverviewResponse,
  RegisterDeviceRequest,
  RegisterDeviceResponse,
  DeviceDto,
  TaskSummary,
  Task,
  TaskStatus,
  InboxItem,
  ListInboxResponse,
  PreferenceEntry,
  EventSummary,
  Paginated,
  MobileAuthTokenResponse,
} from "./contract";

export interface BffClientOptions {
  fetchFn: FetchFn;
  store: SessionStore;
  onLogout: () => void;
}

export class MobileBffClient {
  private readonly transport: HttpTransport;
  private readonly auth: AuthInterceptor;
  private readonly store: SessionStore;

  constructor(opts: BffClientOptions) {
    this.transport = new HttpTransport(opts.fetchFn);
    this.store = opts.store;
    // refreshFn hits transport directly (no interceptor) to avoid recursion.
    this.auth = new AuthInterceptor(
      opts.store,
      (refreshToken) =>
        this.transport.send<MobileAuthTokenResponse>(
          { method: "POST", path: "/auth/refresh", body: { refreshToken } },
          null,
        ),
      opts.onLogout,
    );
  }

  // ---- S1 auth (unauthenticated) ----
  async exchange(code: string): Promise<MobileAuthTokenResponse> {
    const res = await this.transport.send<MobileAuthTokenResponse>(
      { method: "POST", path: "/auth/exchange", body: { code, platform: MOBILE_PLATFORM } },
      null,
    );
    this.store.setSession(res.token, res.refreshToken ?? null);
    return res;
  }
  async logout(): Promise<void> {
    const token = this.store.getToken();
    try {
      await this.transport.send<void>({ method: "POST", path: "/auth/logout" }, token);
    } finally {
      this.store.clear();
    }
  }

  // ---- S2 home (aggregate) ----
  getHome(): Promise<MobileHomeResponse> {
    return this.auth.execute((t) => this.transport.send({ method: "GET", path: "/bff/home" }, t));
  }

  // ---- S3/S4 events ----
  getEvents(cursor?: string): Promise<Paginated<EventSummary>> {
    return this.auth.execute((t) =>
      this.transport.send({ method: "GET", path: "/events", query: { cursor } }, t),
    );
  }
  getEventOverview(eventId: string): Promise<MobileEventOverviewResponse> {
    return this.auth.execute((t) =>
      this.transport.send({ method: "GET", path: `/bff/events/${eventId}` }, t),
    );
  }

  // ---- S5/S6 tasks ----
  getMyTasks(cursor?: string): Promise<Paginated<TaskSummary>> {
    return this.auth.execute((t) =>
      this.transport.send({ method: "GET", path: "/tasks", query: { assignee: "me", cursor } }, t),
    );
  }
  getTask(id: string): Promise<Task> {
    return this.auth.execute((t) => this.transport.send({ method: "GET", path: `/tasks/${id}` }, t));
  }
  /** Single online PATCH + baseVersion (theme3 D4). 409 -> AppError.Conflict. */
  updateTaskStatus(id: string, status: TaskStatus, baseVersion: number): Promise<Task> {
    return this.auth.execute((t) =>
      this.transport.send(
        { method: "PATCH", path: `/tasks/${id}`, body: { version: baseVersion, status } },
        t,
      ),
    );
  }

  // ---- S7 inbox ----
  getInbox(cursor?: string): Promise<ListInboxResponse> {
    return this.auth.execute((t) =>
      this.transport.send({ method: "GET", path: "/inbox", query: { cursor } }, t),
    );
  }
  markRead(id: string): Promise<InboxItem> {
    return this.auth.execute((t) =>
      this.transport.send({ method: "PATCH", path: `/inbox/${id}/read` }, t),
    );
  }
  markAllRead(): Promise<void> {
    return this.auth.execute((t) =>
      this.transport.send({ method: "POST", path: "/inbox/read-all" }, t),
    );
  }

  // ---- S8 preferences ----
  getPreferences(): Promise<PreferenceEntry[]> {
    return this.auth.execute((t) =>
      this.transport.send({ method: "GET", path: "/preferences" }, t),
    );
  }
  updatePreferences(prefs: PreferenceEntry[]): Promise<PreferenceEntry[]> {
    return this.auth.execute((t) =>
      this.transport.send({ method: "PATCH", path: "/preferences", body: { preferences: prefs } }, t),
    );
  }

  // ---- device registration (push) ----
  registerDevice(pushToken: string): Promise<RegisterDeviceResponse> {
    const body: RegisterDeviceRequest = { platform: MOBILE_PLATFORM, pushToken };
    return this.auth.execute(async (t) => {
      const res = await this.transport.send<RegisterDeviceResponse>(
        { method: "POST", path: "/devices", body },
        t,
      );
      this.store.setDeviceId(res.deviceId);
      return res;
    });
  }
  listDevices(): Promise<DeviceDto[]> {
    return this.auth.execute((t) => this.transport.send({ method: "GET", path: "/devices" }, t));
  }
  deleteDevice(deviceId: string): Promise<void> {
    return this.auth.execute((t) =>
      this.transport.send({ method: "DELETE", path: `/devices/${deviceId}` }, t),
    );
  }
}
