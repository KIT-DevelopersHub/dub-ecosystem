// ロール管理「その他」> Google アカウント のダイアログ本文。Hackit Drive の共有などで Google を
// 操作するときに使うアカウントを表示し、システム管理者が接続し直せるようにする。
//
//   - 複数アプリに効きうる組織全体の設定なので、特定アプリのダイアログではなく「その他」に置く
//   - 全ロール共通の設定で、ロールの「保存」とは別に接続した時点で切り替わる
//   - 「接続し直す」は Google の画面へ移動する。未保存のロール編集は下書きとして残り、戻ると同じ
//     ロールのこのダイアログが開く (/admin/roles?code&state で接続を完了する)
import { useEffect, useRef, useState } from "react";
import { policy } from "@dub/types";
import { Badge, Button, Skeleton } from "@dub/ui";
import type { BadgeTone } from "@dub/ui";
import { usePermissions } from "../hooks/usePermissions";
import { useCompleteDriveGoogleConnect, useDriveGoogleAccount, useStartDriveGoogleConnect } from "../hooks/useDriveGoogleAccount";
import { errorMessage } from "../lib/errorDisplay";
import { OAUTH_RETURN_SETTING, clearOAuthReturn, markOAuthReturn, oauthRedirectUri, readOAuthReturn } from "../lib/oauthReturn";
import type { DriveGoogleAccountStatus } from "../contracts/pending";

const blockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-2, 8px)" };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: 0 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--dub-space-3, 12px)",
  flexWrap: "wrap",
  padding: "var(--dub-space-3, 12px)",
  border: "1px solid var(--dub-color-border-default, #dde1e9)",
  borderRadius: "var(--dub-radius-md, 6px)",
};
const accountStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const emailLineStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" };
const emailStyle: React.CSSProperties = { fontWeight: 600, wordBreak: "break-all" };
const metaStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12 };
const alertStyle: React.CSSProperties = { ...hintStyle, color: "var(--dub-color-danger-700, #b42318)" };

const APP_ID = "driveshare";
/** サーバーの POLICY_TABLE と同じ条件 (Drive共有 編集 + drive:write + identity:admin)。 */
const REQUIRED_KEYS = [...policy.keysForAppLevel(APP_ID, policy.AppAccessLevel.Edit), "drive:write", "identity:admin"] as const;

function formatConnectedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function badgeFor(s: DriveGoogleAccountStatus): { tone: BadgeTone; label: string } {
  if (s.needsReconnect) return { tone: "danger", label: "要再接続" };
  if (s.source === "connected") return { tone: "success", label: "接続済み" };
  if (s.source === "secret") return { tone: "neutral", label: "初期設定" };
  return { tone: "neutral", label: "未接続" };
}

function metaFor(s: DriveGoogleAccountStatus): string | null {
  if (s.source === "connected" && s.connectedAt) return `接続日時: ${formatConnectedAt(s.connectedAt)}`;
  if (s.source === "secret") return "サーバーの初期設定のアカウント";
  return null;
}

/** 戻り URL を 1 回だけ処理する (StrictMode の二重 effect・再マウントで二重送信しない)。 */
const handledStates = new Set<string>();

export function DriveGoogleAccountPanel({ idPrefix = "fe7" }: { idPrefix?: string }) {
  const { canAll, ready } = usePermissions();
  const isAdmin = ready && canAll(REQUIRED_KEYS);
  const status = useDriveGoogleAccount(isAdmin);
  const start = useStartDriveGoogleConnect();
  const complete = useCompleteDriveGoogleConnect();
  const [returnError, setReturnError] = useState<string | null>(null);
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
      setReturnError(ret.error === "access_denied" ? "接続がキャンセルされました。" : "接続できませんでした。もう一度お試しください。");
      return;
    }
    complete.mutate({ code: ret.code, state: ret.state }, { onError: (err) => setReturnError(errorMessage(err)) });
  }, [ready, isAdmin, complete]);

  function goToGoogle() {
    markOAuthReturn(OAUTH_RETURN_SETTING);
    start.mutate(oauthRedirectUri());
  }

  const s = status.data;
  const meta = s ? metaFor(s) : null;

  return (
    <section style={blockStyle} data-testid={tid}>
      <p style={hintStyle} data-testid={`${tid}-owner-note`}>
        Hackit Drive の共有に使います。アカウントを切り替えても既存ファイルのオーナーは移りません。
      </p>

      {returnError ? (
        <p style={alertStyle} role="alert" data-testid={`${tid}-return-error`}>{returnError}</p>
      ) : null}

      {!ready ? (
        <Skeleton variant="rect" height={58} testId={`${tid}-loading`} />
      ) : !isAdmin ? (
        <p style={hintStyle} data-testid={`${tid}-admin-only`}>システム管理者だけが変更できます。</p>
      ) : status.isPending || complete.isPending ? (
        <div style={rowStyle} data-testid={`${tid}-loading`} aria-busy="true">
          <div style={{ ...accountStyle, flex: 1 }}>
            <Skeleton width="50%" height={18} />
            <Skeleton width="30%" />
          </div>
          <Skeleton variant="rect" width={96} height={32} />
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
          <div style={rowStyle} data-testid={`${tid}-account`}>
            <div style={accountStyle}>
              <span style={emailLineStyle}>
                <span style={emailStyle} data-testid={`${tid}-email`}>
                  {s.source === "none" ? "なし" : (s.email ?? "（不明）")}
                </span>
                <Badge tone={badgeFor(s).tone} testId={`${tid}-badge`}>{badgeFor(s).label}</Badge>
              </span>
              {meta ? <span style={metaStyle} data-testid={`${tid}-meta`}>{meta}</span> : null}
            </div>
            <Button
              variant={s.needsReconnect || s.source === "none" ? "primary" : "secondary"}
              size="sm"
              onClick={goToGoogle}
              loading={start.isPending || start.isSuccess}
              disabled={!s.canConnect}
              testId={`${tid}-connect`}
            >
              {s.source === "none" ? "Google アカウントを接続" : "接続し直す"}
            </Button>
          </div>
          {s.needsReconnect ? (
            <p style={alertStyle} role="alert" data-testid={`${tid}-reconnect-warning`}>認証が切れています。再接続してください。</p>
          ) : null}
          {!s.canConnect ? (
            <p style={hintStyle} data-testid={`${tid}-unconfigured`}>サーバーの接続設定が未完了のため接続できません。</p>
          ) : null}
        </>
      )}
    </section>
  );
}
