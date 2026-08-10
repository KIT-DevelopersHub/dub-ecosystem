// Login screen (design 2-1). Two paths that share the same KV session backend:
//   1. Email + password (self-owned credentials — no Google dependency).
//   2. Google OAuth (unchanged).
// On a successful password login the server has set the session cookie, so we do a
// full navigation to redirectPath; the shell re-boots, /me returns 200 and the
// authenticated app renders.
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
      const { authorizeUrl } = await api.auth.loginStart(redirectPath);
      globalThis.location.assign(authorizeUrl);
    } catch (e) {
      setBusy(false);
      setError(messageFor(e, "ログインを開始できませんでした。"));
    }
  }

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  return (
    <main data-testid="fe2-login">
      <h1>DevHub 管理コンソール</h1>

      <form
        data-testid="fe2-login-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submitPassword();
        }}
      >
        <label htmlFor="fe2-login-email">メールアドレス</label>
        <TextField
          id="fe2-login-email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          disabled={busy}
          testId="fe2-login-email"
        />
        <label htmlFor="fe2-login-password">パスワード</label>
        <TextField
          id="fe2-login-password"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder="パスワード"
          disabled={busy}
          testId="fe2-login-password"
        />
        <Button testId="fe2-login-submit" type="submit" loading={busy} disabled={!canSubmit}>
          ログイン
        </Button>
      </form>

      <Button variant="secondary" testId="fe2-login-google" disabled={busy} onClick={() => void startGoogleLogin()}>
        Google でログイン
      </Button>

      {error ? (
        <p role="alert" data-testid="fe2-login-error">
          {error}
        </p>
      ) : null}
    </main>
  );
}
