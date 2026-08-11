// Self password change (#5b). The logged-in user rotates their OWN password from the
// shell chrome — deliberately separate from the admin roster surface (FE7), which is for
// managing OTHER users. Posts to the gateway-owned POST /api/v1/me/password, which
// re-verifies the session + current password server-side before storing the new hash.
import { useState } from "react";
import { Modal, Button, TextField, FormField } from "@dub/ui";
import { ApiError, toDisplayableError, type ApiClient } from "../lib/api-client.tsx";

const MIN_LENGTH = 8;

export function ChangePasswordDialog({
  api,
  open,
  onClose,
}: {
  api: ApiClient;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function reset() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
    setDone(false);
    setSubmitting(false);
  }

  function close() {
    reset();
    onClose();
  }

  const tooShort = next.length > 0 && next.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= MIN_LENGTH && next === confirm && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.auth.changePassword(current, next);
      setDone(true);
    } catch (e) {
      setError(ApiError.isApiError(e) ? toDisplayableError(e).message : "パスワードの変更に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="パスワードを変更"
      testId="fe2-change-password"
      footer={
        done ? (
          <Button variant="primary" onClick={close} testId="fe2-change-password-close">
            閉じる
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} testId="fe2-change-password-cancel">
              キャンセル
            </Button>
            <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={submitting} testId="fe2-change-password-submit">
              変更する
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p data-testid="fe2-change-password-done">パスワードを変更しました。次回のログインから新しいパスワードを使用してください。</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FormField label="現在のパスワード" htmlFor="fe2-cp-current">
            <TextField id="fe2-cp-current" type="password" value={current} onChange={setCurrent} testId="fe2-cp-current" />
          </FormField>
          <FormField label={`新しいパスワード（${MIN_LENGTH}文字以上）`} htmlFor="fe2-cp-next">
            <TextField id="fe2-cp-next" type="password" value={next} onChange={setNext} invalid={tooShort} testId="fe2-cp-next" />
          </FormField>
          <FormField label="新しいパスワード（確認）" htmlFor="fe2-cp-confirm">
            <TextField id="fe2-cp-confirm" type="password" value={confirm} onChange={setConfirm} invalid={mismatch} testId="fe2-cp-confirm" />
          </FormField>
          {mismatch ? (
            <p role="alert" style={{ color: "var(--dub-color-fg-danger, #cf222e)", fontSize: 13, margin: 0 }}>
              新しいパスワードが一致しません。
            </p>
          ) : null}
          {error ? (
            <p role="alert" data-testid="fe2-change-password-error" style={{ color: "var(--dub-color-fg-danger, #cf222e)", fontSize: 13, margin: 0 }}>
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
