// メール設定 > Gmail への自動転送 (opt-in, per user). Register a personal address →
// Cloudflare mails it a verification link → once verified, mail delivered to you is also
// forwarded there. Every mutation is optimistic (useForwardSetting).
import { useState } from "react";
import type { mail } from "@dub/types";
import { Badge, Button, ConfirmDialog, EmptyState, Form, FormField, Modal, SkeletonList, Switch, TextField } from "@dub/ui";
import { FormError } from "@dub/app-ui";
import { useForwardSetting } from "./useForwardSetting.tsx";
import styles from "./forward.module.css";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fmt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function StatusBadge({ s }: { s: mail.MailForwardSetting }): JSX.Element {
  if (s.status === "pending") return <Badge tone="warning" testId="fe2-mail-forward-status">確認待ち</Badge>;
  if (s.active) return <Badge tone="success" testId="fe2-mail-forward-status">転送中</Badge>;
  return <Badge tone="neutral" testId="fe2-mail-forward-status">オフ</Badge>;
}

function AddressForm({ initial, submitLabel, onSubmit, onCancel }: { initial: string; submitLabel: string; onSubmit: (v: string) => void; onCancel?: () => void }): JSX.Element {
  const [value, setValue] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const submit = (): void => {
    const v = value.trim();
    if (!EMAIL_RE.test(v)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSubmit(v);
  };
  return (
    <Form onSubmit={submit} testId="fe2-mail-forward-form">
      <FormField
        label="転送先のメールアドレス"
        htmlFor="fe2-mail-forward-target"
        help="ご自身の Gmail など、あなたが受信できるアドレスを入力してください。"
        {...(invalid ? { error: "メールアドレスの形式で入力してください。" } : {})}
      >
        <TextField id="fe2-mail-forward-target" type="email" value={value} onChange={setValue} placeholder="you@gmail.com" invalid={invalid} testId="fe2-mail-forward-input" />
      </FormField>
      <div className={styles.actions}>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} testId="fe2-mail-forward-cancel">
            キャンセル
          </Button>
        ) : null}
        <Button type="submit" testId="fe2-mail-forward-submit">
          {submitLabel}
        </Button>
      </div>
    </Form>
  );
}

export function ForwardSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const f = useForwardSetting(open);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const s = f.setting;

  let body: JSX.Element;
  if (f.load === "loading" && !s) {
    body = <SkeletonList rows={3} testId="fe2-mail-forward-loading" />;
  } else if (!s) {
    body = (
      <EmptyState
        icon="alert"
        title="設定を読み込めませんでした"
        description="時間をおいてもう一度お試しください。"
        action={
          <Button variant="secondary" onClick={f.refresh} testId="fe2-mail-forward-retry">
            再読み込み
          </Button>
        }
        testId="fe2-mail-forward-error"
      />
    );
  } else if (!s.available && s.status === "none") {
    body = <EmptyState icon="info" title="現在この機能は利用できません" description="管理者による設定が完了すると使えるようになります。" testId="fe2-mail-forward-unavailable" />;
  } else if (s.status === "none" || editing) {
    body = (
      <AddressForm
        initial={editing ? (s.target ?? "") : ""}
        submitLabel="確認メールを送信"
        onSubmit={(v) => {
          setEditing(false);
          f.register(v);
        }}
        {...(editing ? { onCancel: () => setEditing(false) } : {})}
      />
    );
  } else {
    body = (
      <div className={styles.stack}>
        <div className={styles.targetRow}>
          <span className={styles.target} data-testid="fe2-mail-forward-target">
            {s.target}
          </span>
          <StatusBadge s={s} />
        </div>
        {s.status === "pending" ? (
          <div className={styles.notice} role="status" data-testid="fe2-mail-forward-pending">
            <p className={styles.noticeText}>
              {s.target} に Cloudflare から確認メールを送りました。メール内のリンクを開くと転送が始まります（届かない場合は迷惑メールもご確認ください）。
            </p>
            <div className={styles.actions}>
              <Button variant="secondary" size="sm" onClick={f.refresh} testId="fe2-mail-forward-check">
                確認状況を更新
              </Button>
              <Button variant="ghost" size="sm" onClick={() => s.target && f.register(s.target)} testId="fe2-mail-forward-resend">
                確認メールを再送
              </Button>
            </div>
          </div>
        ) : null}
        <Switch
          id="fe2-mail-forward-enabled"
          checked={s.enabled}
          onChange={f.setEnabled}
          label="届いたメールをこのアドレスに自動転送する"
          disabled={!s.available}
          testId="fe2-mail-forward-toggle"
        />
        {s.lastAt ? (
          <p className={styles.meta} data-testid="fe2-mail-forward-last">
            {s.lastResult === "failed" ? `最後の転送に失敗しました（${fmt(s.lastAt)}）。メールは Dub に保存されています。` : `最後の転送: ${fmt(s.lastAt)}`}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} testId="fe2-mail-forward-change">
            アドレスを変更
          </Button>
          <Button variant="danger" size="sm" onClick={() => setConfirmRemove(true)} testId="fe2-mail-forward-remove">
            登録を解除
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Gmail への自動転送"
        footer={
          <Button variant="secondary" onClick={onClose} testId="fe2-mail-forward-close">
            閉じる
          </Button>
        }
        testId="fe2-mail-forward-dialog"
      >
        <div className={styles.stack}>
          <p className={styles.lead}>
            あなた宛てに届いたメールを、ご自身の Gmail などにも自動でコピーします（バックアップ用）。オンにするかは自由です。転送されるのはあなた宛てのメールだけで、共有メールボックスは対象外です。
          </p>
          <FormError testId="fe2-mail-forward-failure">{f.error}</FormError>
          {body}
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmRemove}
        title="自動転送の登録を解除しますか？"
        message="今後のメールは転送されなくなります。すでに転送されたメールや Dub 上のメールは削除されません。"
        confirmLabel="解除する"
        danger
        onConfirm={() => {
          setConfirmRemove(false);
          f.remove();
        }}
        onCancel={() => setConfirmRemove(false)}
        testId="fe2-mail-forward-remove-confirm"
      />
    </>
  );
}
