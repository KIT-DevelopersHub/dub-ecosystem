// token-store — Keychain abstraction (design §1 "Bearer トークン・Keychain 保管").
// The Swift app backs this with the iOS Keychain; the reference layer ships an
// in-memory impl for tests. Logout MUST clear everything (design §3).
export interface StoredSession {
  /** Single opaque bearer token (theme8). */
  token: string;
  /** epoch-ms session expiry mirror (auth.SessionInfo.sessionExpiresAt). */
  sessionExpiresAt: number;
}

export interface TokenStore {
  read(): StoredSession | null;
  write(session: StoredSession): void;
  clear(): void;
}

export class InMemoryTokenStore implements TokenStore {
  #session: StoredSession | null = null;

  read(): StoredSession | null {
    return this.#session;
  }

  write(session: StoredSession): void {
    this.#session = session;
  }

  clear(): void {
    this.#session = null;
  }
}
