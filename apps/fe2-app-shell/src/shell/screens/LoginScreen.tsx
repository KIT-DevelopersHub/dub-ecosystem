// Login screen (design 2-1). Two paths that share the same KV session backend:
//   1. Email + password (self-owned credentials — no Google dependency).
//   2. Google OAuth (unchanged).
// On a successful password login the server has set the session cookie, so we do a
// full navigation to redirectPath; the shell re-boots, /me returns 200 and the
// authenticated app renders.
//
// The design chrome (.fe2-login* classes in styles/global.css) centres the card
// and gives it surface/shadow/brand-mark; without these classNames the page is
// bare markup even though the stylesheet is loaded (regression fixed here).
import { useState } from "react";
import { Button, TextField } from "@dub/ui";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";

export function LoginScreen({ api, redirectPath = "/" }: { api: ApiClient; redirectPath?: string }): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function messageFor(e: unknown, fallback: string): string {
    return ApiError.isApiError(e) ? toDisplayableError(e).message : fallback;
  }

  async function submitPassword(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.passwordLogin(email.trim(), password);
      globalThis.location.assign(redirectPath);
    } catch (e) {
      setBusy(false);
      setError(messageFor(e, "メールアドレスまたはパスワードが正しくありません。"));
    }
  }

  async function startGoogleLogin(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Send an absolute, same-origin return URL so the auth-service redirect
      // allowlist matches this SPA's origin (relative "/" is not allowlistable).
      const returnTo = new URL(redirectPath, globalThis.location.origin).toString();
      const { authorizationUrl } = await api.auth.loginStart(returnTo);
      globalThis.location.assign(authorizationUrl);
    } catch (e) {
      setBusy(false);
      setError(messageFor(e, "ログインを開始できませんでした。"));
    }
  }

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  return (
    <main data-testid="fe2-login" className="fe2-login">
      <div className="fe2-login-card">
        <span className="fe2-login-mark" aria-hidden="true">
          D
        </span>
        <div className="fe2-login-head">
          <h1 className="fe2-login-title">DevHub 管理コンソール</h1>
          <p className="fe2-login-sub">運営メンバー専用のサインインです</p>
        </div>

        <form
          className="fe2-login-form"
          data-testid="fe2-login-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void submitPassword();
          }}
        >
          <div className="fe2-login-field">
            <label className="fe2-login-label" htmlFor="fe2-login-email">
              メールアドレス
            </label>
            <TextField
              id="fe2-login-email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              disabled={busy}
              testId="fe2-login-email"
            />
          </div>
          <div className="fe2-login-field">
            <label className="fe2-login-label" htmlFor="fe2-login-password">
              パスワード
            </label>
            <TextField
              id="fe2-login-password"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="パスワード"
              disabled={busy}
              testId="fe2-login-password"
            />
          </div>
          <Button
            className="fe2-login-block"
            testId="fe2-login-submit"
            type="submit"
            size="lg"
            loading={busy}
            disabled={!canSubmit}
          >
            ログイン
          </Button>
        </form>

        <div className="fe2-login-divider" aria-hidden="true">
          <span>または</span>
        </div>

        <Button
          className="fe2-login-block"
          variant="secondary"
          size="lg"
          testId="fe2-login-google"
          disabled={busy}
          onClick={() => void startGoogleLogin()}
        >
          Google でログイン
        </Button>

        {error ? (
          <p role="alert" data-testid="fe2-login-error" className="fe2-login-error">
            {error}
          </p>
        ) : null}

        <p className="fe2-login-foot">DevelopersHub 北陸ITカンファレンス 運営基盤</p>
      </div>
    </main>
  );
}
