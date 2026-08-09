// Login screen (design 2-1). Starts Google login; auth is public at the gateway.
import { useState } from "react";
import { Button } from "../../stubs/dub-ui.tsx";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";

export function LoginScreen({ api, redirectPath = "/" }: { api: ApiClient; redirectPath?: string }): JSX.Element {
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
      setError(ApiError.isApiError(e) ? toDisplayableError(e).description : "ログインを開始できませんでした。");
    }
  }

  return (
    <main data-testid="fe2-login">
      <h1>DevHub 管理コンソール</h1>
      <Button testId="fe2-login-submit" disabled={busy} onClick={() => void startLogin()}>
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
