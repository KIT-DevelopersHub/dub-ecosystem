// STAGING / DEMO ONLY debug menu: one-click account switch (= role preview), current
// user / permissions / app access, and environment + build info.
//
// Never in the production bundle: main.tsx lazy-imports this module only behind the
// VITE_DEMO_AUTOLOGIN (staging) / VITE_DEMO build flags, which production builds do not set,
// so Rollup drops the chunk (CI asserts this with scripts/assert-no-staging-debug.mjs).
// The backend side is equally gated: /auth/demo-accounts and /auth/demo-login exist only on
// an auth-service running with DEMO_AUTOLOGIN=1 (staging), and switch only among a fixed
// server-side allowlist of seed accounts.
import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, ConfirmDialog, Drawer, EmptyState, ErrorState, IconButton, SkeletonList } from "@dub/ui";
import { appRegistry, policy } from "@dub/types";
import type { gateway } from "@dub/types";
import { useAuth } from "../auth/AuthProvider.tsx";
import type { ApiClient } from "../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../lib/api-client.tsx";
import { useStagingDebugShortcut } from "./useStagingDebugShortcut.ts";
import styles from "./StagingDebugMenu.module.css";

export type StagingDebugMode = "staging" | "demo";

export interface StagingDebugMenuProps {
  api: ApiClient;
  mode: StagingDebugMode;
  apiBaseUrl: string;
  /** Show the floating button (staging always; demo only with ?debug=1, so demo E2E/visual
   *  snapshots are unaffected — the shortcut works everywhere the menu is compiled in). */
  showFab: boolean;
  buildInfo?: { sha: string; time: string };
}

const MODE_LABEL: Record<StagingDebugMode, string> = { staging: "staging", demo: "デモ（バックエンド無し・モック）" };

function displayError(e: unknown) {
  return ApiError.isApiError(e)
    ? toDisplayableError(e)
    : { code: "UNKNOWN", message: "読み込みに失敗しました", retryable: true };
}

function CurrentUser({ me }: { me: gateway.MeResponse }): JSX.Element {
  const access = me.appAccess ?? policy.appAccessMap(me.permissions);
  const isAdmin = me.permissions.includes("identity:admin");
  return (
    <section className={styles.section} data-testid="fe2-debug-current">
      <h3 className={styles.heading}>現在のユーザー</h3>
      <dl className={styles.kv}>
        <dt>表示名</dt>
        <dd>{me.user.displayName}</dd>
        <dt>メール</dt>
        <dd>{me.user.email ?? "—"}</dd>
        <dt>userId</dt>
        <dd className={styles.mono}>{me.user.id}</dd>
        <dt>orgId</dt>
        <dd className={styles.mono}>{me.orgId}</dd>
        <dt>権限</dt>
        <dd>
          <span className={styles.badges}>
            <Badge tone={isAdmin ? "brand" : "neutral"}>{isAdmin ? "管理者（identity:admin）" : "非管理者"}</Badge>
            <Badge>{me.permissions.length} 権限</Badge>
          </span>
        </dd>
      </dl>
      <details className={styles.details}>
        <summary className={styles.summary}>アプリごとの権限（無効 / 閲覧 / 編集）</summary>
        <div className={styles.apps} data-testid="fe2-debug-app-access">
          {appRegistry.APP_MANIFEST.map((app) => {
            const level = access[app.id] ?? policy.AppAccessLevel.None;
            return (
              <Fragment key={app.id}>
                <span>{app.label}</span>
                <Badge tone={level === "edit" ? "success" : level === "view" ? "info" : "neutral"}>
                  {policy.APP_ACCESS_LEVEL_LABELS[level]}
                </Badge>
              </Fragment>
            );
          })}
        </div>
      </details>
    </section>
  );
}

function AccountSwitcher({ api, currentUserId }: { api: ApiClient; currentUserId: string | null }): JSX.Element {
  const accounts = useQuery({ queryKey: ["staging-debug", "demo-accounts"], queryFn: () => api.auth.demoAccounts() });
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function switchTo(email: string): Promise<void> {
    setSwitching(email);
    setError(null);
    try {
      // Revoke the current session first so switching never leaves orphan sessions live.
      await api.auth.logout().catch(() => undefined);
      await api.auth.demoLogin(email);
      globalThis.location.reload();
    } catch (e) {
      setSwitching(null);
      setError(ApiError.isApiError(e) ? toDisplayableError(e).message : "切り替えに失敗しました");
    }
  }

  let content: JSX.Element;
  if (accounts.isLoading) content = <SkeletonList rows={4} testId="fe2-debug-accounts-loading" />;
  else if (accounts.isError) content = <ErrorState error={displayError(accounts.error)} onRetry={() => void accounts.refetch()} />;
  else if (!accounts.data || accounts.data.accounts.length === 0)
    content = <EmptyState title="切り替え可能なアカウントがありません" description="staging の名簿に seed アカウントが居ません" />;
  else
    content = (
      <ul className={styles.list} data-testid="fe2-debug-accounts">
        {accounts.data.accounts.map((a) => {
          const current = a.userId === currentUserId;
          return (
            <li key={a.email} className={styles.account} data-current={current ? "true" : "false"}>
              <div className={styles.accountMain}>
                <span className={styles.accountName}>
                  {a.displayName}
                  <Badge tone="brand">{a.label}</Badge>
                  {current ? <Badge tone="success">ログイン中</Badge> : null}
                </span>
                <span className={styles.accountEmail}>{a.email}</span>
              </div>
              <Button
                size="sm"
                variant={current ? "ghost" : "secondary"}
                disabled={current || switching !== null}
                loading={switching === a.email}
                testId={`fe2-debug-switch-${a.email}`}
                onClick={() => void switchTo(a.email)}
              >
                {current ? "使用中" : "切替"}
              </Button>
            </li>
          );
        })}
      </ul>
    );

  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>アカウント / ロール切替</h3>
      <p className={styles.hint}>seed アカウントにワンクリックで入り直します。ロールの見え方はそのアカウントの権限で確認できます。</p>
      {content}
      {error ? (
        <p role="alert" className={styles.hint} data-testid="fe2-debug-switch-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const DEMO_STORAGE_PREFIXES = ["dub-demo", "dub_demo"];

function DemoReset(): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>デモデータ</h3>
      <p className={styles.hint}>このブラウザに保存されたデモの状態（選択アカウント・設定など）を消して初期状態に戻します。</p>
      <div>
        <Button size="sm" variant="secondary" testId="fe2-debug-demo-reset" onClick={() => setConfirming(true)}>
          デモデータをリセット
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="デモデータをリセットしますか？"
        message="このブラウザのデモ用の保存データを消して再読み込みします。"
        confirmLabel="リセット"
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          for (const store of [globalThis.localStorage, globalThis.sessionStorage]) {
            try {
              for (const key of Object.keys(store)) {
                if (DEMO_STORAGE_PREFIXES.some((p) => key.startsWith(p))) store.removeItem(key);
              }
            } catch {
              // storage blocked: nothing to clear
            }
          }
          globalThis.location.reload();
        }}
      />
    </section>
  );
}

const BUILD_INFO = typeof __FE2_BUILD_INFO__ === "undefined" ? undefined : __FE2_BUILD_INFO__;

export default function StagingDebugMenu({ api, mode, apiBaseUrl, showFab, buildInfo = BUILD_INFO }: StagingDebugMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const auth = useAuth();
  useStagingDebugShortcut(() => setOpen((v) => !v));
  const [fab, setFab] = useState(showFab);
  useEffect(() => {
    if (showFab) return;
    try {
      const q = new URLSearchParams(globalThis.location.search).get("debug");
      if (q === "1") globalThis.sessionStorage.setItem("dub-debug-fab", "1");
      if (globalThis.sessionStorage.getItem("dub-debug-fab") === "1") setFab(true);
    } catch {
      // storage blocked: shortcut still works
    }
  }, [showFab]);

  const me = auth.status === "authenticated" ? auth.me : null;
  return (
    <>
      {fab ? (
        <div className={styles.fab} data-testid="fe2-staging-debug-fab">
          <IconButton name="settings" aria-label="デバッグメニューを開く（⌘⇧D）" variant="ghost" onClick={() => setOpen(true)} />
        </div>
      ) : null}
      <Drawer open={open} onClose={() => setOpen(false)} title="デバッグメニュー" testId="fe2-staging-debug-menu">
        <div className={styles.body}>
          <AccountSwitcher api={api} currentUserId={me?.user.id ?? null} />
          {me ? <CurrentUser me={me} /> : <p className={styles.hint}>未ログインです。上のアカウントから入れます。</p>}
          {mode === "demo" ? <DemoReset /> : null}
          <section className={styles.section} data-testid="fe2-debug-env">
            <h3 className={styles.heading}>環境 / ビルド</h3>
            <dl className={styles.kv}>
              <dt>モード</dt>
              <dd>{MODE_LABEL[mode]}</dd>
              <dt>ホスト</dt>
              <dd className={styles.mono}>{globalThis.location.host}</dd>
              <dt>API</dt>
              <dd className={styles.mono}>{apiBaseUrl}</dd>
              <dt>コミット</dt>
              <dd className={styles.mono}>{buildInfo?.sha ?? "—"}</dd>
              <dt>ビルド日時</dt>
              <dd className={styles.mono}>{buildInfo?.time ?? "—"}</dd>
            </dl>
            <p className={styles.hint}>⌘⇧D（Windows は Ctrl+Shift+D）で開閉できます。</p>
          </section>
        </div>
      </Drawer>
    </>
  );
}
