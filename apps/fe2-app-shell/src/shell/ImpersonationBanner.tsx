// 代理表示 (admin impersonation) banner: 「〇〇さんとして表示中 · 残りN分 · 自分に戻る」.
// Rendered at the top of the sticky shell header whenever /me carries `impersonation`, so
// it is on every screen and cannot scroll away. At the hard deadline it returns the admin
// automatically (there is no refresh for an impersonation session). Returning reloads the
// shell so every cached query is re-read as the admin.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@dub/ui";
import type { ApiClient } from "../lib/api-client.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";
import styles from "./ImpersonationBanner.module.css";

const TICK_MS = 15_000;

/** Whole minutes left, rounded UP so "残り1分" shows until the very end (never "残り0分" early). */
export function remainingMinutes(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

function defaultReload(path: string): void {
  window.location.assign(path);
}

export function ImpersonationBanner({
  api,
  reload = defaultReload,
  now: nowFn = Date.now,
}: {
  api: Pick<ApiClient, "auth">;
  /** Full navigation after returning (tests inject a spy). */
  reload?: (path: string) => void;
  /** Clock (tests inject a fixed one). */
  now?: () => number;
}): JSX.Element | null {
  const auth = useAuth();
  const me = auth.status === "authenticated" ? auth.me : null;
  const imp = me?.impersonation ?? null;
  const [now, setNow] = useState(nowFn);
  const [returning, setReturning] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!imp) return undefined;
    setNow(nowFn());
    const t = setInterval(() => setNow(nowFn()), TICK_MS);
    return () => clearInterval(t);
  }, [imp, nowFn]);

  const returnToSelf = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    setReturning(true);
    try {
      await api.auth.stopImpersonation();
    } catch {
      // Already ended server-side (expired / refreshed) or the admin's own session died:
      // the reload lands on whatever the cookie now is (own account or the login screen).
    }
    reload("/");
  }, [api, reload]);

  const expiresAt = imp?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt !== null && now >= expiresAt) void returnToSelf();
  }, [expiresAt, now, returnToSelf]);

  if (!me || !imp) return null;
  const minutes = remainingMinutes(imp.expiresAt, now);

  return (
    <div className={styles.banner} role="status" aria-live="polite" data-testid="fe2-impersonation-banner">
      <span className={styles.message}>
        <span>
          <span className={styles.subject} data-testid="fe2-impersonation-subject">
            {me.user.displayName}
          </span>
          さんとして表示中
        </span>
        <span className={styles.sep} aria-hidden="true">
          ·
        </span>
        <span className={styles.remaining} data-testid="fe2-impersonation-remaining">
          残り{minutes}分
        </span>
        <span className={styles.note}>操作は {imp.actor.displayName} として記録されます</span>
      </span>
      <Button variant="secondary" size="sm" loading={returning} onClick={() => void returnToSelf()} testId="fe2-impersonation-return">
        自分に戻る
      </Button>
    </div>
  );
}
