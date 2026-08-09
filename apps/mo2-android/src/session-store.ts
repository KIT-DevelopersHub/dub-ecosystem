// SessionStore — the client-side secret vault abstraction. On Android the impl
// is EncryptedDataStore (§3); here we model the contract + an in-memory impl for
// tests. Holds a single opaque session token (theme8, no 2-token/JWT), the
// mobile refresh token, and the server-issued deviceId ULID. Never logged.
export interface SessionStore {
  getToken(): string | null;
  getRefreshToken(): string | null;
  getDeviceId(): string | null;
  setSession(token: string, refreshToken: string | null): void;
  setDeviceId(deviceId: string): void;
  clear(): void; // logout
}

export class InMemorySessionStore implements SessionStore {
  private token: string | null = null;
  private refreshToken: string | null = null;
  private deviceId: string | null = null;

  getToken(): string | null {
    return this.token;
  }
  getRefreshToken(): string | null {
    return this.refreshToken;
  }
  getDeviceId(): string | null {
    return this.deviceId;
  }
  setSession(token: string, refreshToken: string | null): void {
    this.token = token;
    this.refreshToken = refreshToken;
  }
  setDeviceId(deviceId: string): void {
    this.deviceId = deviceId;
  }
  clear(): void {
    this.token = null;
    this.refreshToken = null;
    // deviceId is kept — it survives logout (server ULID; §3).
  }
}
