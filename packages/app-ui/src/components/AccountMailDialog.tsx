// AccountMailDialog — layer ② composite. "アカウント発行メールを送りますか？" asked right
// after an 運営メンバー is linked to an @developershub.jp login (and from the roster row for a
// resend). Data-injected: the caller owns the send mutation + toast; this only shows who
// receives what and reports 送る / あとで.
import { Modal, Button } from "@dub/ui";
import { DialogActions } from "./DialogActions";
import { FormError } from "./FormError";
import styles from "./AccountMailDialog.module.css";

/** The login URL the mail carries (gateway APP_BASE_URL default). */
export const ACCOUNT_MAIL_APP_URL = "https://app.developershub.jp";

export interface AccountMailDialogProps {
  open: boolean;
  /** 運営メンバーの氏名. */
  name: string;
  /** 宛先 = the member's Gmail. */
  to: string;
  /** CC = the member's @developershub.jp login (also the send record). */
  cc: string | null;
  appUrl?: string;
  sending?: boolean;
  /** Send failure message (shown inline; the dialog stays open for a retry). */
  error?: string | null;
  onSend: () => void;
  /** 「あとで」/ close. */
  onClose: () => void;
  testId?: string;
}

export function AccountMailDialog({
  open,
  name,
  to,
  cc,
  appUrl = ACCOUNT_MAIL_APP_URL,
  sending = false,
  error,
  onSend,
  onClose,
  testId = "account-mail-dialog",
}: AccountMailDialogProps): JSX.Element {
  return (
    <Modal
      open={open}
      onClose={sending ? () => {} : onClose}
      title="アカウント発行メールを送りますか？"
      size="md"
      testId={testId}
      footer={
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={sending} testId={`${testId}-later`}>
            あとで
          </Button>
          <Button variant="primary" onClick={onSend} loading={sending} testId={`${testId}-send`}>
            送る
          </Button>
        </DialogActions>
      }
    >
      <div className={styles.body}>
        <p className={styles.lead}>
          「{name}」さんの Gmail に、アプリ URL・ログイン用メールアドレス・初期パスワードを1通で送ります。
          パスワードが未発行なら初期パスワードを発行して送ります。既にある場合は現在のパスワードを送ります。
        </p>
        <dl className={styles.list}>
          <dt className={styles.term}>宛先（Gmail）</dt>
          <dd className={styles.value} data-testid={`${testId}-to`}>{to}</dd>
          <dt className={styles.term}>CC</dt>
          <dd className={styles.value} data-testid={`${testId}-cc`}>{cc ?? "ログイン用の @developershub.jp アドレス"}</dd>
          <dt className={styles.term}>アプリ URL</dt>
          <dd className={styles.value} data-testid={`${testId}-app-url`}>{appUrl}</dd>
        </dl>
        <FormError testId={`${testId}-error`}>{error}</FormError>
      </div>
    </Modal>
  );
}
