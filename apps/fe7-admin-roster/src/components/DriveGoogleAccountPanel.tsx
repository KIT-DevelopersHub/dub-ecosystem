// ロール管理「その他」> Google アカウント のダイアログ本文。アプリ内の Google Drive 連携
// (Hackit Drive の共有など) が使う Google アカウントを複数登録しておき、使うものを切り替える。
//
//   - 複数アプリに効きうる組織全体の設定なので、特定アプリのダイアログではなく「その他」に置く
//   - 全ロール共通の設定で、ロールの「保存」とは別に操作した時点で切り替わる
//   - 「アカウントを追加」「再接続」は Google の画面へ移動する。未保存のロール編集は下書きとして
//     残り、戻ると同じロールのこのダイアログが開く (/admin/roles?code&state で追加を完了する)
//   - 追加したアカウントはそのまま使用中になる。サーバー初期設定 (Secret) のアカウントも 1 行で並ぶ
import { useEffect, useRef, useState } from "react";
import { policy } from "@dub/types";
import { Badge, Button, ConfirmDialog, Skeleton } from "@dub/ui";
import { usePermissions } from "../hooks/usePermissions";
import {
  useCompleteDriveGoogleConnect,
  useDriveGoogleAccounts,
  useRemoveDriveGoogleAccount,
  useStartDriveGoogleConnect,
  useSwitchDriveGoogleAccount,
} from "../hooks/useDriveGoogleAccount";
import { errorMessage } from "../lib/errorDisplay";
import { OAUTH_RETURN_SETTING, clearOAuthReturn, markOAuthReturn, oauthRedirectUri, readOAuthReturn } from "../lib/oauthReturn";
import type { DriveGoogleAccount } from "../contracts/pending";

const blockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-3, 12px)" };
const listStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-2, 8px)", margin: 0, padding: 0, listStyle: "none" };
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

const APP_ID = "driveshare";
/** サーバーの POLICY_TABLE と同じ条件 (Drive共有 編集 + drive:write + identity:admin)。 */
const REQUIRED_KEYS = [...policy.keysForAppLevel(APP_ID, policy.AppAccessLevel.Edit), "drive:write", "identity:admin"] as const;

function formatConnectedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function metaFor(a: DriveGoogleAccount): string | null {
  if (a.kind === "secret") return "サーバーの初期設定のアカウント";
  return a.connectedAt ? `接続日時: ${formatConnectedAt(a.connectedAt)}` : null;
}

/** 戻り URL を 1 回だけ処理する (StrictMode の二重 effect・再マウントで二重送信しない)。 */
const handledStates = new Set<string>();

export function DriveGoogleAccountPanel({ idPrefix = "fe7" }: { idPrefix?: string }) {
  const { canAll, ready } = usePermissions();
  const isAdmin = ready && canAll(REQUIRED_KEYS);
  const status = useDriveGoogleAccounts(isAdmin);
  const start = useStartDriveGoogleConnect();
  const complete = useCompleteDriveGoogleConnect();
  const switchTo = useSwitchDriveGoogleAccount();
  const remove = useRemoveDriveGoogleAccount();
  const [returnError, setReturnError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<DriveGoogleAccount | null>(null);
  const started = useRef(false);
  const tid = `${idPrefix}-drive-google`;

  useEffect(() => {
    if (!ready || started.current) return;
    const ret = readOAuthReturn();
    if (!ret) return;
    started.current = true;
    clearOAuthReturn();
    if (!isAdmin) return;
    const key = ret.state ?? ret.error ?? "";
    if (handledStates.has(key)) return;
    handledStates.add(key);
    if (ret.error || !ret.code || !ret.state) {
      setReturnError(ret.error === "access_denied" ? "追加がキャンセルされました。" : "追加できませんでした。もう一度お試しください。");
      return;
    }
    complete.mutate({ code: ret.code, state: ret.state }, { onError: (err) => setReturnError(errorMessage(err)) });
  }, [ready, isAdmin, complete]);

  function goToGoogle() {
    markOAuthReturn(OAUTH_RETURN_SETTING);
    start.mutate(oauthRedirectUri());
  }

  const s = status.data;
  const activeBroken = s?.accounts.some((a) => a.active && a.needsReconnect) ?? false;

  return (
    <section style={blockStyle} data-testid={tid}>
      <p style={hintStyle} data-testid={`${tid}-owner-note`}>
        アプリ内の Google Drive 連携で使うアカウントです。切り替えても既存ファイルのオーナーは移りません。
      </p>

      {returnError ? (
        <p style={alertStyle} role="alert" data-testid={`${tid}-return-error`}>{returnError}</p>
      ) : null}

      {!ready ? (
        <Skeleton variant="rect" height={58} testId={`${tid}-loading`} />
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
          <span style={hintStyle}>読み込めませんでした（{errorMessage(status.error)}）</span>
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
                  </div>
                  <span style={actionsStyle}>
                    {a.needsReconnect && s.canConnect ? (
                      <Button variant="primary" size="sm" onClick={goToGoogle} loading={start.isPending} testId={`${tid}-reconnect-${a.id}`}>
                        再接続
                      </Button>
                    ) : null}
                    {!a.active ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => switchTo.mutate(a.id)}
                        disabled={switchTo.isPending}
                        testId={`${tid}-switch-${a.id}`}
                      >
                        切り替える
                      </Button>
                    ) : null}
                    {!a.active && a.kind === "connected" ? (
                      <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(a)} testId={`${tid}-remove-${a.id}`}>
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
              onClick={goToGoogle}
              loading={start.isPending || start.isSuccess}
              disabled={!s.canConnect}
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
          if (confirmRemove) remove.mutate(confirmRemove.id);
          setConfirmRemove(null);
        }}
        onCancel={() => setConfirmRemove(null)}
        testId={`${tid}-remove-confirm`}
      />
    </section>
  );
}
