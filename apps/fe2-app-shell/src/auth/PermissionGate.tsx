// 「権限が不足しています」ダイアログ + 権限を申請する。
//
// アプリは開けるがアプリ内の操作権限が足りない(ロール管理で「閲覧」・編集範囲の外)とき、
// 書き込みボタンを disabled で黙らせる代わりに、押したらこのダイアログで理由を伝え、その場で
// 管理者へ権限を申請できるようにする。申請は既存の問い合わせ経路(POST /api/v1/feedback,
// kind=permission_request)に乗り、notif:receive_admin 保持者(admin ロール等)の通知に届く。
//
// 使い方:
//   const gate = usePermissionGate({ appId: "members", locked: !canEdit });
//   <Button onClick={gate.guard(openAdd)}>追加</Button>
//   {gate.dialog}
// サーバー側の認可(policy-table)はそのまま。これは UI 上の案内でしかない。
import { useCallback, useState } from "react";
import { Button, Modal } from "@dub/ui";
import { ApiError, toDisplayableError } from "../lib/api-client.tsx";
import { capturePageContext, submitInquiry } from "../shell/inquiry/inquiryApi.tsx";
import { useAppCapability, useViewerApi } from "./AuthProvider.tsx";

type Status = "idle" | "submitting" | "done" | "error";
export type PermissionScope = "edit" | "scope";

// 同じセッションで同じ申請を繰り返して管理者の通知を埋めないよう、申請済みを覚えておく。
const storageKey = (appId: string, scope: PermissionScope) => `dub:permission-request:${appId}:${scope}`;
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

const textStyle: React.CSSProperties = { margin: 0, lineHeight: 1.7 };
const bodyStyle: React.CSSProperties = { display: "grid", gap: "var(--dub-space-3, 12px)" };
const doneStyle: React.CSSProperties = { ...textStyle, color: "var(--dub-color-success-700, #1a7f37)" };
const errorStyle: React.CSSProperties = { ...textStyle, color: "var(--dub-color-danger-600, #c62828)" };

export interface PermissionGateOptions {
  /** APP_MANIFEST の id。 */
  appId: string;
  /** true なら guard した操作の代わりにダイアログを出す。 */
  locked: boolean;
  /** "edit" = アプリの編集権限 / "scope" = アプリは編集だが編集範囲の外。 */
  scope?: PermissionScope;
  /** 何ができないかの説明。省略時は「<アプリ>は閲覧のみの権限のため…」。 */
  reason?: string;
  testId?: string;
}

export interface PermissionGate {
  locked: boolean;
  /** locked なら権限不足ダイアログを開き、そうでなければ fn をそのまま呼ぶハンドラを返す。 */
  guard: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;
  /** ダイアログを直接開く (disabled な入力欄など、クリックを guard できない所の案内用)。 */
  open: () => void;
  /** 画面のどこかに 1 回だけ置く。 */
  dialog: JSX.Element;
}

export function usePermissionGate({ appId, locked, scope = "edit", reason, testId }: PermissionGateOptions): PermissionGate {
  const [open, setOpen] = useState(false);
  const guard = useCallback(
    <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        if (locked) setOpen(true);
        else fn(...args);
      },
    [locked],
  );
  const dialog = (
    <PermissionRequestDialog
      open={open}
      onClose={() => setOpen(false)}
      appId={appId}
      scope={scope}
      {...(reason !== undefined ? { reason } : {})}
      testId={testId ?? `perm-dialog-${appId}`}
    />
  );
  return { locked, guard, open: () => setOpen(true), dialog };
}

function PermissionRequestDialog({
  open,
  onClose,
  appId,
  scope,
  reason,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  appId: string;
  scope: PermissionScope;
  reason?: string;
  testId: string;
}): JSX.Element {
  const { label } = useAppCapability(appId);
  const { api, displayName } = useViewerApi();
  const key = storageKey(appId, scope);
  const [status, setStatus] = useState<Status>(() => (wasRequested(key) ? "done" : "idle"));
  const [errorText, setErrorText] = useState<string | null>(null);
  const why = reason ?? `${label}は閲覧のみの権限のため、作成・編集・削除はできません。`;
  const wanted = scope === "edit" ? `${label}の編集` : `${label}の編集範囲の拡大`;

  const request = async (): Promise<void> => {
    if (status === "submitting" || status === "done") return;
    setStatus("submitting");
    setErrorText(null);
    const message = [
      `申請者: ${displayName ?? "(不明)"}`,
      `アプリ: ${label}`,
      `状況: ${why}`,
      `希望する権限: ${wanted}`,
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
    <Modal
      open={open}
      onClose={onClose}
      title="権限が不足しています"
      size="sm"
      testId={testId}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} testId={`${testId}-close`}>
            閉じる
          </Button>
          <Button
            variant="primary"
            loading={status === "submitting"}
            disabled={status === "done"}
            onClick={() => void request()}
            testId={`${testId}-request`}
          >
            {status === "done" ? "申請済み" : "権限を申請する"}
          </Button>
        </>
      }
    >
      <div style={bodyStyle}>
        <p style={textStyle}>{why}</p>
        {status === "done" ? (
          <p style={doneStyle} data-testid={`${testId}-request-done`}>
            申請しました。管理者に通知したので、権限が付与されるまでお待ちください。
          </p>
        ) : (
          <p style={textStyle}>必要な場合は、管理者に「{wanted}」の権限を申請できます。</p>
        )}
        {status === "error" && errorText ? (
          <p style={errorStyle} role="alert" data-testid={`${testId}-request-error`}>
            {errorText}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
