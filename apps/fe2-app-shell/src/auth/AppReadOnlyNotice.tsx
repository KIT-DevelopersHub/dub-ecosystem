// 「権限が不足しています」の共通バナー + 権限を申請するボタン。
//
// アプリは開けるがアプリ内の操作権限が足りない(ロール管理で「閲覧」・編集範囲の外)とき、
// 書き込みボタンは disabled になる。灰色のボタンだけでは理由も次の一手も分からないので、
// 画面上部に理由を出し、その場で管理者へ権限を申請できるようにする。申請は既存の問い合わせ
// パイプライン(POST /api/v1/feedback, kind=permission_request)に乗り、notif:receive_admin
// 保持者(admin ロール等)の通知に届く。
//
// 使い方: 書き込み UI を持つ画面の先頭に <AppReadOnlyNotice appId="members" /> を置き、
// 各ボタンに disabled={!canEdit} を付ける。appId は APP_MANIFEST の id。
import { useState } from "react";
import { Button } from "@dub/ui";
import { ApiError, toDisplayableError } from "../lib/api-client.tsx";
import { capturePageContext, submitInquiry } from "../shell/inquiry/inquiryApi.tsx";
import { useAppCapability, useViewerApi } from "./AuthProvider.tsx";

const style: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  gap: "var(--dub-space-3, 12px)",
  padding: "var(--dub-space-3, 12px) var(--dub-space-4, 16px)",
  marginBottom: "var(--dub-space-4, 16px)",
  border: "1px solid var(--dub-color-warning-200, #f5d58a)",
  borderRadius: "var(--dub-radius-md, 8px)",
  background: "var(--dub-color-warning-50, #fff8e6)",
  color: "var(--dub-color-text-secondary, #424a53)",
  fontSize: 13,
  lineHeight: 1.6,
};
const bodyStyle: React.CSSProperties = { flex: 1, minWidth: 0, display: "grid", gap: "var(--dub-space-1, 4px)" };
const titleStyle: React.CSSProperties = { fontWeight: 600, color: "var(--dub-color-text-primary, #1f2328)" };
const errorStyle: React.CSSProperties = { color: "var(--dub-color-danger-600, #c62828)" };

type Status = "idle" | "submitting" | "done" | "error";

// 同じセッションで同じアプリを何度も申請して管理者の通知を埋めないよう、申請済みを覚えておく。
const storageKey = (appId: string, scope: string) => `dub:permission-request:${appId}:${scope}`;
function wasRequested(key: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}
function markRequested(key: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, "1");
  } catch {
    // storage 不可(プライベートモード等)でも申請自体は成功している
  }
}

interface PermissionRequestNoticeProps {
  appId: string;
  /** 何ができないかの説明(1 文)。 */
  reason: string;
  /** 申請の種類。申請済みの記憶と管理者向け本文の「希望する権限」に使う。 */
  scope: "edit" | "scope";
  testId: string;
}

function PermissionRequestNotice({ appId, reason, scope, testId }: PermissionRequestNoticeProps): JSX.Element {
  const { label } = useAppCapability(appId);
  const { api, displayName } = useViewerApi();
  const key = storageKey(appId, scope);
  const [status, setStatus] = useState<Status>(() => (wasRequested(key) ? "done" : "idle"));
  const [errorText, setErrorText] = useState<string | null>(null);

  const request = async (): Promise<void> => {
    if (status === "submitting" || status === "done") return;
    setStatus("submitting");
    setErrorText(null);
    const message = [
      `申請者: ${displayName ?? "(不明)"}`,
      `アプリ: ${label}`,
      `状況: ${reason}`,
      `希望する権限: ${scope === "edit" ? `${label}の編集` : `${label}の編集範囲の拡大`}`,
      "",
      "付与する場合は 管理 → ロール管理 で、この人のロールに権限を追加してください。",
    ].join("\n");
    try {
      await submitInquiry(api, { kind: "permission_request", category: "other", message, ...capturePageContext() });
      markRequested(key);
      setStatus("done");
    } catch (e) {
      setStatus("error");
      setErrorText(ApiError.isApiError(e) ? toDisplayableError(e).message : "申請に失敗しました。時間をおいて再度お試しください。");
    }
  };

  return (
    <div style={style} role="status" data-testid={testId}>
      <span aria-hidden>🔒</span>
      <div style={bodyStyle}>
        <span style={titleStyle}>権限が不足しています</span>
        <span>{reason}</span>
        {status === "done" ? (
          <span data-testid={`${testId}-request-done`}>申請しました。管理者に通知したので、権限が付与されるまでお待ちください。</span>
        ) : null}
        {status === "error" && errorText ? (
          <span style={errorStyle} role="alert" data-testid={`${testId}-request-error`}>
            {errorText}
          </span>
        ) : null}
      </div>
      <Button
        variant="secondary"
        size="sm"
        loading={status === "submitting"}
        disabled={status === "done"}
        onClick={() => void request()}
        testId={`${testId}-request`}
      >
        {status === "done" ? "申請済み" : "権限を申請する"}
      </Button>
    </div>
  );
}

/** アプリが「閲覧」のとき、編集できない理由と申請ボタンを出す。編集・無効のときは何も描画しない。 */
export function AppReadOnlyNotice({ appId, testId }: { appId: string; testId?: string }): JSX.Element | null {
  const { readOnly, label } = useAppCapability(appId);
  if (!readOnly) return null;
  return (
    <PermissionRequestNotice
      appId={appId}
      scope="edit"
      reason={`${label}は閲覧のみの権限のため、作成・編集・削除はできません。`}
      testId={testId ?? `app-readonly-${appId}`}
    />
  );
}

/** アプリは編集でも、範囲の外の画面では押せない理由と申請ボタンを出す (運営メンバーの編集範囲など)。 */
export function ScopeReadOnlyNotice({ appId, message, testId }: { appId: string; message: string; testId: string }): JSX.Element {
  return <PermissionRequestNotice appId={appId} scope="scope" reason={message} testId={testId} />;
}
