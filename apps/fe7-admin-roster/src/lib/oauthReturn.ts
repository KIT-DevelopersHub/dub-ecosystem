// Google の同意画面から戻ってきた URL (/admin/roles?code&state / ?error&state) の読み書き。
// 戻り先は 1 ページに固定(サーバー側の redirect URI 許可リストと一致させる)。どのアプリの
// 設定パネルが始めたかは sessionStorage に印を付けておき、戻ったら同じ詳細ダイアログを開く。

export const OAUTH_RETURN_PATH = "/admin/roles";
const MARK_KEY = "fe7:oauth-return-app";
const ROLE_KEY = "fe7:oauth-return-role";

export interface OAuthReturn {
  code: string | null;
  state: string | null;
  /** Google が返した error (access_denied = 同意画面でキャンセル). */
  error: string | null;
}

export function oauthRedirectUri(): string {
  return `${window.location.origin}${OAUTH_RETURN_PATH}`;
}

/** 同意画面へ移動する直前に、戻ったとき開くアプリを記録する。 */
export function markOAuthReturn(appId: string): void {
  try {
    window.sessionStorage.setItem(MARK_KEY, appId);
  } catch {
    // storage 不可 (プライベートモード等) でも戻りの処理自体は URL だけで成立する
  }
}

export function readOAuthReturn(): OAuthReturn | null {
  if (typeof window === "undefined" || window.location.pathname !== OAUTH_RETURN_PATH) return null;
  const q = new URLSearchParams(window.location.search);
  const ret = { code: q.get("code"), state: q.get("state"), error: q.get("error") };
  return ret.state || ret.error ? ret : null;
}

/** code / state をアドレスバーと履歴から消す (リロードで二重送信しない・共有されない)。 */
export function clearOAuthReturn(): void {
  try {
    window.sessionStorage.removeItem(MARK_KEY);
  } catch {
    // ignore
  }
  window.history.replaceState(window.history.state, "", window.location.pathname);
}

/** 戻ってきた直後なら、開くべきアプリ (詳細ダイアログ) の id。 */
export function pendingOAuthReturnApp(fallback: string): string | null {
  if (!readOAuthReturn()) return null;
  try {
    return window.sessionStorage.getItem(MARK_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

/** ロール管理で今開いているロール。戻ったときに同じロールを選び直す(下書きもそこにある)。 */
export function rememberActiveRole(roleId: string | null): void {
  try {
    if (roleId) window.sessionStorage.setItem(ROLE_KEY, roleId);
  } catch {
    // ignore
  }
}

/** Google から戻ってきた直後なら、移動前に開いていたロールの id。 */
export function oauthReturnRole(): string | null {
  if (!readOAuthReturn()) return null;
  try {
    return window.sessionStorage.getItem(ROLE_KEY);
  } catch {
    return null;
  }
}
