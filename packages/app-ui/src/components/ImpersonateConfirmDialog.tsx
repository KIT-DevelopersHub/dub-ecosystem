// 代理表示 (admin impersonation) の確認ダイアログ。メール名簿の右ペイン (FE7) と
// ヘッダーのメンバー切り替え (FE2) の両方から同じ文言で出す。データは注入のみ。
import { ConfirmDialog } from "@dub/ui";
import styles from "./ImpersonateConfirmDialog.module.css";

export interface ImpersonateConfirmDialogProps {
  open: boolean;
  /** The member to view as (null keeps the dialog closed). */
  displayName: string | null;
  /** Session length in minutes (shown in the copy). */
  minutes: number;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  testId?: string;
}

export function ImpersonateConfirmDialog({ open, displayName, minutes, onConfirm, onCancel, testId }: ImpersonateConfirmDialogProps): JSX.Element {
  const name = displayName ?? "";
  return (
    <ConfirmDialog
      open={open && displayName !== null}
      title={`${name}さんとして表示しますか？`}
      message={
        <>
          <span>
            {name}さんの権限で、{minutes}分間アプリを表示します。上部のバナーからいつでも自分に戻れます。
          </span>
          <ul className={styles.list}>
            <li>表示中の操作はすべてあなたの名前で記録されます</li>
            <li>パスワード・ログイン方法・権限の変更とメール送信はできません</li>
          </ul>
        </>
      }
      confirmLabel="表示する"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...(testId ? { testId } : {})}
    />
  );
}
