// Drive共有 > 設定 (admin only). Holds the Google account drive-share-service acts as: several
// accounts can be registered and the one in use switched. It is an org-wide setting of this app
// (not per role), so it lives here rather than in ロール管理.
//
//   - 「アカウントを追加」「再接続」 leave the SPA for Google; Google returns to /driveshare?code&state
//     (the server only accepts that one path) and the dialog reopens to finish the add.
//   - A new account becomes the one in use; 再接続 only refreshes that row's token. The server's
//     initial Secret account is listed too (it cannot be reconnected from here).
//   - Direct link: /driveshare?setting=google-account opens the dialog.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ConfirmDialog, Modal, Skeleton, useToast } from "@dub/ui";
import { useAppCapability, useAuth, usePermissions } from "../../auth/AuthProvider.tsx";
import { createOptimisticMutation } from "../../lib/optimistic.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { useDriveShareApi } from "./DriveShareProvider.tsx";
import type { DriveGoogleAccount, DriveGoogleAccountsStatus } from "./driveShareApi.tsx";

export const DRIVE_SETTINGS_PATH = "/driveshare";
export const GOOGLE_ACCOUNT_SETTING = "google-account";
const GOOGLE_KEY = queryKeys.feature("driveshare", "google-account");

/** Same gate as the server's POLICY_TABLE: Drive共有 編集 + drive:write + identity:admin. */
export function useCanManageDriveSettings(): boolean {
  const { can } = usePermissions();
  const { canEdit } = useAppCapability("driveshare");
  return canEdit && can("drive:write") && can("identity:admin");
}

interface OAuthReturn {
  code: string | null;
  state: string | null;
  /** Google's error (access_denied = cancelled on the consent screen). */
  error: string | null;
}

function readOAuthReturn(): OAuthReturn | null {
  if (typeof window === "undefined" || window.location.pathname !== DRIVE_SETTINGS_PATH) return null;
  const q = new URLSearchParams(window.location.search);
  const ret = { code: q.get("code"), state: q.get("state"), error: q.get("error") };
  return ret.state || ret.error ? ret : null;
}

/** The dialog opens on load when Google just sent the admin back, or via ?setting=google-account. */
export function settingsOpenOnLoad(): boolean {
  if (typeof window === "undefined" || window.location.pathname !== DRIVE_SETTINGS_PATH) return false;
  return readOAuthReturn() !== null || new URLSearchParams(window.location.search).get("setting") === GOOGLE_ACCOUNT_SETTING;
}

/** Drop code/state/?setting from the address bar (no double submit on reload, never shared). */
function clearSettingsParams(): void {
  if (typeof window === "undefined" || window.location.pathname !== DRIVE_SETTINGS_PATH || !window.location.search) return;
  window.history.replaceState(window.history.state, "", window.location.pathname);
}

function formatConnectedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function metaFor(a: DriveGoogleAccount): string | null {
  if (a.kind === "secret") return "サーバーの初期設定のアカウント";
  return a.connectedAt ? `接続日時: ${formatConnectedAt(a.connectedAt)}` : null;
}

/** Handle one return URL once (StrictMode double effects / remounts must not resubmit). */
const handledStates = new Set<string>();

const blockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-3, 12px)" };
const listStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-2, 8px)", margin: 0, padding: 0, listStyle: "none" };
const headingStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: 0 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--dub-space-3, 12px)",
  flexWrap: "wrap",
  padding: "var(--dub-space-3, 12px)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--dub-color-border-default, #dde1e9)",
  borderRadius: "var(--dub-radius-md, 6px)",
};
const activeRowStyle: React.CSSProperties = {
  ...rowStyle,
  borderColor: "var(--dub-color-success-500, #12b76a)",
  background: "var(--dub-color-success-50, #ecfdf3)",
};
const accountStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const emailLineStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" };
const emailStyle: React.CSSProperties = { fontWeight: 600, wordBreak: "break-all" };
const metaStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12 };
const actionsStyle: React.CSSProperties = { display: "inline-flex", gap: "var(--dub-space-2, 8px)", flexWrap: "wrap" };
const alertStyle: React.CSSProperties = { ...hintStyle, color: "var(--dub-color-danger-700, #b42318)" };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "もう一度お試しください。";
}

export function DriveShareSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const close = () => {
    clearSettingsParams();
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Drive共有の設定"
      size="md"
      testId="fe2-driveshare-settings"
      footer={
        <Button variant="secondary" onClick={close} testId="fe2-driveshare-settings-close">
          閉じる
        </Button>
      }
    >
      <GoogleAccountSection />
    </Modal>
  );
}

function GoogleAccountSection(): JSX.Element {
  const driveApi = useDriveShareApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  // Permissions are all false while /me loads: wait before judging admin (or the return is lost).
  const ready = useAuth().status !== "loading";
  const isAdmin = useCanManageDriveSettings();
  const tid = "fe2-driveshare-google";

  const status = useQuery({
    queryKey: GOOGLE_KEY,
    queryFn: () => driveApi.getGoogleAccounts(),
    enabled: isAdmin,
    // The server probes Google; reopening the dialog within a minute reuses the answer.
    staleTime: 60_000,
  });

  const start = useMutation({
    mutationFn: ({ loginHint }: { loginHint?: string }) =>
      driveApi.startGoogleConnect(`${window.location.origin}${DRIVE_SETTINGS_PATH}`, loginHint),
    onSuccess: ({ authUrl }) => window.location.assign(authUrl),
    onError: (err) => toast.show({ kind: "error", title: "Google への接続を開始できませんでした", description: errorText(err) }),
  });

  const complete = useMutation({
    mutationFn: ({ code, state }: { code: string; state: string }) => driveApi.completeGoogleConnect(code, state),
    onSuccess: (next) => {
      queryClient.setQueryData(GOOGLE_KEY, next);
      const active = next.accounts.find((a) => a.active);
      toast.show({ kind: "success", title: "Google アカウントを接続しました", description: active ? `使用中: ${active.email ?? "（不明）"}` : undefined });
    },
  });

  const switchTo = useMutation(
    createOptimisticMutation<DriveGoogleAccountsStatus, string, DriveGoogleAccountsStatus>(queryClient, {
      mutationFn: (id) => driveApi.switchGoogleAccount(id),
      cacheKey: GOOGLE_KEY,
      applyOptimistic: (prev, id) => ({ ...prev, accounts: prev.accounts.map((a) => ({ ...a, active: a.id === id })) }),
      onErrorToast: (err) => toast.show({ kind: "error", title: "アカウントを切り替えられませんでした", description: err.message }),
    }),
  );
  // Destructive: not optimistic (behind ConfirmDialog), like revoke on the main screen.
  const remove = useMutation({
    mutationFn: (account: DriveGoogleAccount) => driveApi.removeGoogleAccount(account.id),
    onSuccess: (_void, account) => {
      void queryClient.invalidateQueries({ queryKey: GOOGLE_KEY });
      toast.show({ kind: "success", title: `${account.email ?? "選んだアカウント"} を削除しました` });
    },
    onError: (err) => toast.show({ kind: "error", title: "アカウントを削除できませんでした", description: errorText(err) }),
  });

  const [returnError, setReturnError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<DriveGoogleAccount | null>(null);
  /** The row heading to Google (null = 「アカウントを追加」): only that button spins. */
  const [leavingFor, setLeavingFor] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!ready || started.current) return;
    const ret = readOAuthReturn();
    if (!ret) return;
    started.current = true;
    clearSettingsParams();
    if (!isAdmin) return;
    const key = ret.state ?? ret.error ?? "";
    if (handledStates.has(key)) return;
    handledStates.add(key);
    if (ret.error || !ret.code || !ret.state) {
      setReturnError(ret.error === "access_denied" ? "追加がキャンセルされました。" : "追加できませんでした。もう一度お試しください。");
      return;
    }
    complete.mutate({ code: ret.code, state: ret.state }, { onError: (err) => setReturnError(errorText(err)) });
  }, [ready, isAdmin, complete]);

  function goToGoogle(account?: DriveGoogleAccount) {
    setLeavingFor(account?.id ?? null);
    start.mutate(account?.email ? { loginHint: account.email } : {});
  }

  const s = status.data;
  const leaving = start.isPending || start.isSuccess;
  // Never run switch and remove together (one rollback must not overwrite the other's change).
  const busy = switchTo.isPending || remove.isPending || leaving;
  const activeBroken = s?.accounts.some((a) => a.active && a.needsReconnect) ?? false;
  const noneActive = s ? s.accounts.length > 0 && !s.accounts.some((a) => a.active) : false;

  return (
    <section style={blockStyle} data-testid={tid}>
      <h3 style={headingStyle}>Google アカウント</h3>
      <p style={hintStyle} data-testid={`${tid}-owner-note`}>
        Drive共有が Google Drive を操作するときに使うアカウントです。切り替えても既存ファイルのオーナーは移りません。
      </p>

      {returnError ? (
        <p style={alertStyle} role="alert" data-testid={`${tid}-return-error`}>{returnError}</p>
      ) : null}

      {!ready ? (
        <Skeleton variant="rect" height={58} testId={`${tid}-auth-loading`} />
      ) : !isAdmin ? (
        <p style={hintStyle} data-testid={`${tid}-admin-only`}>システム管理者だけが変更できます。</p>
      ) : status.isPending || complete.isPending ? (
        <div style={listStyle} data-testid={`${tid}-loading`} aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} style={rowStyle}>
              <div style={{ ...accountStyle, flex: 1 }}>
                <Skeleton width="50%" height={18} />
                <Skeleton width="30%" />
              </div>
              <Skeleton variant="rect" width={96} height={32} />
            </div>
          ))}
        </div>
      ) : status.isError || !s ? (
        <div style={rowStyle} data-testid={`${tid}-error`}>
          <span style={hintStyle}>読み込めませんでした（{errorText(status.error)}）</span>
          <Button variant="secondary" size="sm" onClick={() => void status.refetch()} testId={`${tid}-retry`}>
            再読み込み
          </Button>
        </div>
      ) : (
        <>
          {activeBroken ? (
            <p style={alertStyle} role="alert" data-testid={`${tid}-reconnect-warning`}>
              使用中のアカウントの認証が切れています。再接続してください。
            </p>
          ) : null}
          {noneActive ? (
            <p style={alertStyle} role="alert" data-testid={`${tid}-none-active`}>
              使用中のアカウントがありません。使うアカウントに切り替えてください。
            </p>
          ) : null}

          {s.accounts.length === 0 ? (
            <div style={rowStyle} data-testid={`${tid}-empty`}>
              <span style={hintStyle}>まだアカウントがありません。</span>
            </div>
          ) : (
            <ul style={listStyle} data-testid={`${tid}-accounts`}>
              {s.accounts.map((a) => (
                <li key={a.id} style={a.active ? activeRowStyle : rowStyle} data-testid={`${tid}-account-${a.id}`}>
                  <div style={accountStyle}>
                    <span style={emailLineStyle}>
                      <span style={emailStyle} data-testid={`${tid}-email-${a.id}`}>{a.email ?? "（不明）"}</span>
                      {a.active ? <Badge tone="success" testId={`${tid}-active-${a.id}`}>使用中</Badge> : null}
                      {a.needsReconnect ? <Badge tone="danger" testId={`${tid}-broken-${a.id}`}>要再接続</Badge> : null}
                    </span>
                    {metaFor(a) ? <span style={metaStyle}>{metaFor(a)}</span> : null}
                    {a.needsReconnect && a.kind === "secret" ? <span style={alertStyle}>サーバー設定の更新が必要です</span> : null}
                  </div>
                  <span style={actionsStyle}>
                    {a.needsReconnect && a.kind === "connected" && s.canConnect ? (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => goToGoogle(a)}
                        loading={leaving && leavingFor === a.id}
                        disabled={busy}
                        testId={`${tid}-reconnect-${a.id}`}
                      >
                        再接続
                      </Button>
                    ) : null}
                    {!a.active ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          switchTo.mutate(a.id, {
                            onSuccess: () => toast.show({ kind: "success", title: `${a.email ?? "選んだアカウント"} に切り替えました` }),
                          })
                        }
                        // Switching to a broken account would fail every Drive call
                        disabled={busy || a.needsReconnect}
                        testId={`${tid}-switch-${a.id}`}
                      >
                        切り替える
                      </Button>
                    ) : null}
                    {!a.active && a.kind === "connected" ? (
                      <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(a)} disabled={busy} testId={`${tid}-remove-${a.id}`}>
                        削除
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div>
            <Button
              variant={s.accounts.length === 0 ? "primary" : "secondary"}
              size="sm"
              onClick={() => goToGoogle()}
              loading={leaving && leavingFor === null}
              disabled={!s.canConnect || busy}
              testId={`${tid}-add`}
            >
              アカウントを追加
            </Button>
          </div>
          {!s.canConnect ? (
            <p style={hintStyle} data-testid={`${tid}-unconfigured`}>サーバーの接続設定が未完了のため追加できません。</p>
          ) : null}
        </>
      )}

      <ConfirmDialog
        title="アカウントを削除"
        message={
          <span>
            <strong>{confirmRemove?.email}</strong> を一覧から削除します。もう一度使うときは追加し直してください。
          </span>
        }
        open={confirmRemove !== null}
        danger
        confirmLabel="削除する"
        cancelLabel="キャンセル"
        onConfirm={() => {
          if (confirmRemove) remove.mutate(confirmRemove);
          setConfirmRemove(null);
        }}
        onCancel={() => setConfirmRemove(null)}
        testId={`${tid}-remove-confirm`}
      />
    </section>
  );
}
