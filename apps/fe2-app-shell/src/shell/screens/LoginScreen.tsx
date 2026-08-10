// Login screen (design 2-1). Starts Google login; auth is public at the gateway.
import { useState } from "react";
import { Button } from "@dub/ui";
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
      setError(ApiError.isApiError(e) ? toDisplayableError(e).message : "ログインを開始できませんでした。");
    }
  }

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
        <Button testId="fe2-login-submit" size="lg" disabled={busy} onClick={() => void startLogin()}>
          {busy ? "リダイレクトしています…" : "Google でログイン"}
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
