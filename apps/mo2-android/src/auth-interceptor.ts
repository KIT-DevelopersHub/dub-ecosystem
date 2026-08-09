// AuthInterceptor — single-token 401 handling (§6, §7). On Unauthorized: refresh
// exactly once (rotating token), retry once; on refresh failure or a second 401,
// clear the session and emit a logout event (drive back to S1). Bearer only.
import { AppErrorException, isAppErrorException } from "./errors";
import type { SessionStore } from "./session-store";
import type { MobileAuthTokenResponse } from "./contract";

export type RefreshFn = (refreshToken: string) => Promise<MobileAuthTokenResponse>;
export type Send<T> = (token: string | null) => Promise<T>;

export class AuthInterceptor {
  private inflightRefresh: Promise<boolean> | null = null;

  constructor(
    private readonly store: SessionStore,
    private readonly refreshFn: RefreshFn,
    private readonly onLogout: () => void,
  ) {}

  async execute<T>(send: Send<T>): Promise<T> {
    try {
      return await send(this.store.getToken());
    } catch (err) {
      if (!isUnauthorized(err)) throw err;
      const refreshed = await this.refreshOnce();
      if (!refreshed) {
        this.logout();
        throw err;
      }
      try {
        return await send(this.store.getToken());
      } catch (retryErr) {
        if (isUnauthorized(retryErr)) this.logout();
        throw retryErr;
      }
    }
  }

  /** Coalesced single refresh: concurrent 401s share one refresh round-trip. */
  private refreshOnce(): Promise<boolean> {
    if (this.inflightRefresh) return this.inflightRefresh;
    const rt = this.store.getRefreshToken();
    if (!rt) return Promise.resolve(false);
    this.inflightRefresh = (async () => {
      try {
        const res = await this.refreshFn(rt);
        this.store.setSession(res.token, res.refreshToken ?? null);
        return true;
      } catch {
        return false;
      } finally {
        this.inflightRefresh = null;
      }
    })();
    return this.inflightRefresh;
  }

  private logout(): void {
    this.store.clear();
    this.onLogout();
  }
}

function isUnauthorized(err: unknown): err is AppErrorException {
  return isAppErrorException(err) && err.appError.kind === "Unauthorized";
}
