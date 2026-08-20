// Login screen (design 2-1). Single path: company email + password (Google OAuth
// was removed). Access is restricted server-side to @developershub.jp mailboxes.
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

  // STAGING ONLY. This button is compiled in only when the VITE_DEMO_AUTOLOGIN build flag
  // is set (staging build). Production builds have it unset ⇒ the button never renders and
  // the demo path is never invoked; even if it were, the backend /auth/demo-login route
  // does not exist in production (404). No password/secret lives in the bundle.
  const demoAutologin = import.meta.env.VITE_DEMO_AUTOLOGIN === "1";
  async function submitDemo(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.demoLogin();
      globalThis.location.assign(redirectPath);
    } catch (e) {
      setBusy(false);
      setError(messageFor(e, "デモログインに失敗しました。"));
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
              placeholder="you@developershub.jp"
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

        {demoAutologin ? (
          <Button
            className="fe2-login-block"
            testId="fe2-login-demo"
            variant="ghost"
            size="lg"
            loading={busy}
            disabled={busy}
            onClick={() => void submitDemo()}
          >
            デモ管理者で入る（staging）
          </Button>
        ) : null}

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
