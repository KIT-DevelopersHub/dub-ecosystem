// Drive共有 の詳細ダイアログ最下段「Google アカウント」。Drive共有 がファイルの共有を操作する
// ときに使う Google アカウントを表示し、システム管理者が接続し直せるようにする。
//
//   - 全ロール共通の設定で、ロールの「保存」とは別に接続した時点で切り替わる(文言で明示)
//   - 「接続し直す」は Google の画面へ移動する = 未保存のロール編集が消えるので、ページ内で
//     一度確認してから進む(モーダルの中にモーダルを重ねない)
//   - Google から戻ってきたとき (/admin/roles?code&state) はこのパネルが開かれ、接続を完了する
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Skeleton } from "@dub/ui";
import type { BadgeTone } from "@dub/ui";
import { usePermissions } from "../hooks/usePermissions";
import { useCompleteDriveGoogleConnect, useDriveGoogleAccount, useStartDriveGoogleConnect } from "../hooks/useDriveGoogleAccount";
import { errorMessage } from "../lib/errorDisplay";
import { clearOAuthReturn, markOAuthReturn, oauthRedirectUri, readOAuthReturn } from "../lib/oauthReturn";
import type { DriveGoogleAccountStatus } from "../contracts/pending";

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--dub-space-3, 12px)",
  paddingTop: "var(--dub-space-5, 20px)",
  borderTop: "1px solid var(--dub-color-border-default, #d0d7de)",
};
const headingStyle: React.CSSProperties = { fontWeight: 700, fontSize: 14, margin: 0 };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: 0 };
const accountRowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "var(--dub-space-2, 8px)", flexWrap: "wrap" };
const emailStyle: React.CSSProperties = { fontWeight: 600, fontSize: 14, wordBreak: "break-all" };
const actionsStyle: React.CSSProperties = { display: "flex", gap: "var(--dub-space-2, 8px)", flexWrap: "wrap", alignItems: "center" };
const noticeStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--dub-space-2, 8px)",
  padding: "var(--dub-space-3, 12px)",
  borderRadius: 8,
  border: "1px solid var(--dub-color-border-warning, #d4a72c)",
  background: "var(--dub-color-bg-warning-subtle, #fff8e1)",
  fontSize: 13,
  lineHeight: 1.6,
};
const ownerNoteStyle: React.CSSProperties = { ...hintStyle, fontWeight: 600 };

const APP_ID = "driveshare";

function formatConnectedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function badgeFor(s: DriveGoogleAccountStatus): { tone: BadgeTone; label: string } {
  if (s.needsReconnect) return { tone: "danger", label: "要再接続" };
  if (s.source === "connected") return { tone: "success", label: "接続済み" };
  if (s.source === "secret") return { tone: "neutral", label: "サーバー初期設定" };
  return { tone: "neutral", label: "未接続" };
}

function returnErrorText(error: string): string {
  return error === "access_denied"
    ? "Google の画面で接続がキャンセルされました。アカウントは切り替わっていません。"
    : "Google から接続を拒否されました。アカウントは切り替わっていません。もう一度お試しください。";
}

/** 戻り URL を 1 回だけ処理する (StrictMode の二重 effect・再マウントで二重送信しない)。 */
const handledStates = new Set<string>();

export function DriveGoogleAccountPanel({ idPrefix = "fe7" }: { idPrefix?: string }) {
  const { can, ready } = usePermissions();
  const isAdmin = ready && can("identity:admin");
  const status = useDriveGoogleAccount(isAdmin);
  const start = useStartDriveGoogleConnect();
  const complete = useCompleteDriveGoogleConnect();
  const [confirming, setConfirming] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);
  const started = useRef(false);
  const tid = `${idPrefix}-drive-google`;

  useEffect(() => {
    if (!isAdmin || started.current) return;
    const ret = readOAuthReturn();
    if (!ret) return;
    started.current = true;
    clearOAuthReturn();
    const key = ret.state ?? ret.error ?? "";
    if (handledStates.has(key)) return;
    handledStates.add(key);
    if (ret.error || !ret.code || !ret.state) {
      setReturnError(returnErrorText(ret.error ?? "unknown"));
      return;
    }
    complete.mutate({ code: ret.code, state: ret.state }, { onError: (err) => setReturnError(errorMessage(err)) });
  }, [isAdmin, complete]);

  function goToGoogle() {
    markOAuthReturn(APP_ID);
    start.mutate(oauthRedirectUri());
  }

  const s = status.data;
  const leaving = start.isPending || start.isSuccess;

  return (
    <section style={sectionStyle} data-testid={tid} aria-labelledby={`${tid}-heading`}>
      <h3 id={`${tid}-heading`} style={headingStyle}>Google アカウント</h3>
      <p style={hintStyle}>
        Drive共有 がファイルの共有を操作するときに使う Google アカウントです。すべてのロールで共通の設定で、
        「保存」とは別に、接続した時点で切り替わります。
      </p>

      {!ready ? (
        <Skeleton width="60%" testId={`${tid}-loading`} />
      ) : !isAdmin ? (
        <p style={hintStyle} data-testid={`${tid}-admin-only`}>アカウントの確認・切り替えはシステム管理者だけが行えます。</p>
      ) : status.isPending || complete.isPending ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid={`${tid}-loading`} aria-busy="true">
          {complete.isPending ? <p style={hintStyle}>Google アカウントを接続しています…</p> : null}
          <Skeleton width="55%" height={18} />
          <Skeleton width="35%" />
          <Skeleton variant="rect" width={140} height={32} />
        </div>
      ) : status.isError || !s ? (
        <div style={actionsStyle} data-testid={`${tid}-error`}>
          <p style={hintStyle}>接続状態を読み込めませんでした（{errorMessage(status.error)}）。</p>
          <Button variant="secondary" size="sm" onClick={() => void status.refetch()} testId={`${tid}-retry`}>
            再読み込み
          </Button>
        </div>
      ) : (
        <>
          {s.needsReconnect ? (
            <div style={noticeStyle} role="alert" data-testid={`${tid}-reconnect-warning`}>
              Google アカウントの認証が切れています（取り消されたか、期限が切れました）。Drive共有 が動かないため、
              「接続し直す」から再接続してください。
            </div>
          ) : null}
          {returnError ? (
            <div style={noticeStyle} role="alert" data-testid={`${tid}-return-error`}>{returnError}</div>
          ) : null}

          <div style={accountRowStyle} data-testid={`${tid}-account`}>
            <span style={hintStyle}>接続中:</span>
            <span style={emailStyle} data-testid={`${tid}-email`}>
              {s.source === "none" ? "なし" : (s.email ?? "（アカウント名を取得できませんでした）")}
            </span>
            <Badge tone={badgeFor(s).tone} testId={`${tid}-badge`}>{badgeFor(s).label}</Badge>
          </div>
          <p style={hintStyle} data-testid={`${tid}-meta`}>
            {s.source === "connected" && s.connectedAt
              ? `接続日時: ${formatConnectedAt(s.connectedAt)}`
              : s.source === "secret"
                ? "サーバーの初期設定のアカウントを使っています。ここで接続すると、そちらに切り替わります。"
                : "Google アカウントが接続されていないため、Drive共有 は実際の Drive を操作できません。"}
          </p>

          {confirming ? (
            <div style={noticeStyle} data-testid={`${tid}-confirm`}>
              <span>
                Google の画面に移動します。Drive共有 に使うアカウントでログインし、アクセスを許可してください。
                このロールで保存していない変更は失われます。
              </span>
              <div style={actionsStyle}>
                <Button onClick={goToGoogle} loading={leaving} testId={`${tid}-confirm-go`}>
                  Google へ進む
                </Button>
                <Button variant="secondary" onClick={() => setConfirming(false)} disabled={leaving} testId={`${tid}-confirm-cancel`}>
                  やめる
                </Button>
              </div>
            </div>
          ) : (
            <div style={actionsStyle}>
              <Button
                variant={s.needsReconnect || s.source === "none" ? "primary" : "secondary"}
                onClick={() => setConfirming(true)}
                disabled={!s.canConnect}
                testId={`${tid}-connect`}
              >
                {s.source === "none" ? "Google アカウントを接続" : "接続し直す"}
              </Button>
              {!s.canConnect ? (
                <span style={hintStyle} data-testid={`${tid}-unconfigured`}>
                  サーバーに接続用の設定（OAuth クライアント・暗号化キー）がまだ無いため、接続できません。
                </span>
              ) : null}
            </div>
          )}
        </>
      )}

      <p style={ownerNoteStyle} data-testid={`${tid}-owner-note`}>アカウントを切り替えても既存ファイルのオーナーは移りません。</p>
    </section>
  );
}
