// Login screen (design 2-1). Prod: starts Google login (auth is public at the
// gateway). Demo builds (VITE_DEMO=1) instead show a credential form gated by the
// two seeded demo accounts (admin / member) — no backend, no OAuth round-trip.
import { useState } from "react";
import { Button, Form, FormField, TextField } from "@dub/ui";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { isDemoEnabled, demoLogin, DEMO_ACCOUNTS } from "../../lib/demo-seed.tsx";

const DEMO = isDemoEnabled(import.meta.env as { VITE_DEMO?: string });

function DemoLoginForm({ redirectPath }: { redirectPath: string }): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function submit(): void {
    setBusy(true);
    setError(null);
    if (demoLogin(email, password)) {
      // Full reload so the demo transport's /me re-reads the fresh session and the
      // shell boots authenticated. redirectPath is the SPA route we came from.
      globalThis.location.assign(redirectPath || "/");
      return;
    }
    setBusy(false);
    setError("メールアドレスまたはパスワードが違います。");
  }

  return (
    <>
      <Form testId="fe2-demo-login-form" onSubmit={submit}>
        <FormField label="メールアドレス" htmlFor="fe2-demo-email">
          <TextField
            id="fe2-demo-email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="admin@dub.local"
            testId="fe2-demo-email"
          />
        </FormField>
        <FormField label="パスワード" htmlFor="fe2-demo-password">
          <TextField
            id="fe2-demo-password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="パスワード"
            testId="fe2-demo-password"
          />
        </FormField>
        <Button type="submit" testId="fe2-login-submit" size="lg" disabled={busy}>
          {busy ? "サインインしています…" : "ログイン"}
        </Button>
      </Form>
      {error ? (
        <p role="alert" data-testid="fe2-login-error" className="fe2-login-error">
          {error}
        </p>
      ) : null}
      <div className="fe2-login-demo-hint" data-testid="fe2-demo-credentials">
        <p className="fe2-login-demo-hint-title">デモ用アカウント（クリックで入力）</p>
        {DEMO_ACCOUNTS.map((a) => (
          <button
            key={a.email}
            type="button"
            className="fe2-login-demo-account"
            data-testid={`fe2-demo-fill-${a.role}`}
            onClick={() => {
              setEmail(a.email);
              setPassword(a.password);
              setError(null);
            }}
          >
            <span className="fe2-login-demo-account-role">{a.label}</span>
            <span className="fe2-login-demo-account-cred">
              {a.email} / {a.password}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function GoogleLogin({ api, redirectPath }: { api: ApiClient; redirectPath: string }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function startLogin(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.auth.loginStart(redirectPath);
      globalThis.location.assign(authorizeUrl);
    } catch (e) {
      setBusy(false);
      setError(ApiError.isApiError(e) ? toDisplayableError(e).message : "ログインを開始できませんでした。");
    }
  }

  return (
    <>
      <Button testId="fe2-login-submit" size="lg" disabled={busy} onClick={() => void startLogin()}>
        {busy ? "リダイレクトしています…" : "Google でログイン"}
      </Button>
      {error ? (
        <p role="alert" data-testid="fe2-login-error" className="fe2-login-error">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function LoginScreen({ api, redirectPath = "/" }: { api: ApiClient; redirectPath?: string }): JSX.Element {
  return (
    <main data-testid="fe2-login" className="fe2-login">
      <div className="fe2-login-card">
        <span className="fe2-login-mark" aria-hidden="true">
          D
        </span>
        <div className="fe2-login-head">
          <h1 className="fe2-login-title">DevHub 管理コンソール</h1>
          <p className="fe2-login-sub">
            {DEMO ? "デモ環境へのサインイン" : "運営メンバー専用のサインインです"}
          </p>
        </div>
        {DEMO ? <DemoLoginForm redirectPath={redirectPath} /> : <GoogleLogin api={api} redirectPath={redirectPath} />}
        <p className="fe2-login-foot">DevelopersHub 北陸ITカンファレンス 運営基盤</p>
      </div>
    </main>
  );
}
