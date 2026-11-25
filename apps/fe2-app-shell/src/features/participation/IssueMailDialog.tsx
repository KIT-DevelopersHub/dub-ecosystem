// 参加届を運営メンバーに追加した直後に出す「メールアドレスも発行しますか？」ダイアログ。
// 発行する = @developershub.jp アドレス発行 → ログインアカウント作成 → 名簿と紐付け →
// (任意) ログイン情報を Gmail へ、をサーバーの 1 回の呼び出しで行う (members:onboard_mail)。
// 付けるロールはサーバーが一般メンバーに固定する (チーム・役職のロールは名簿から自動で付く)。
// 途中で失敗したらサーバーが作った分を戻すので、そのまま「もう一度発行する」でやり直せる。
import { useState } from "react";
import { Button, Checkbox, FormField, Modal, TextField } from "@dub/ui";
import type { member } from "@dub/types";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useOnboardParticipationAccount } from "./hooks.ts";
import type { Participation, RosterMember } from "./contracts.ts";
import styles from "./participation.module.css";

export const MAIL_DOMAIN = "developershub.jp";

/** gateway が作成済みの分を戻しきれなかった時 (再試行しても 409 になるだけ)。 */
const ONBOARD_PARTIAL = "GATEWAY_ONBOARD_PARTIAL";

function errorMessage(err: unknown): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : "発行できませんでした";
}

export function IssueMailDialog({
  participation,
  member: target,
  defaultLocalPart,
  onClose,
  onIssued,
}: {
  participation: Participation;
  member: RosterMember;
  defaultLocalPart: string;
  onClose: () => void;
  /** 発行・紐付けまで済んだ後 (このダイアログを閉じる代わりに呼ぶ)。 */
  onIssued?: (res: member.OnboardAccountResponse) => void;
}): JSX.Element {
  // 案内メールはサーバーが名簿の Gmail に送るので、表示も名簿の Gmail に揃える。
  const gmail = (target.gmail ?? "").trim();
  const [localPart, setLocalPart] = useState(defaultLocalPart);
  const [sendMail, setSendMail] = useState(gmail !== "");
  const issue = useOnboardParticipationAccount();
  const stuck = ApiError.isApiError(issue.error) && issue.error.code === ONBOARD_PARTIAL;

  const submit = (): void => {
    issue.mutate(
      { participationId: participation.id, localPart: localPart.trim().toLowerCase(), sendAccountMail: sendMail && gmail !== "" },
      { onSuccess: (res) => (onIssued ? onIssued(res) : onClose()) },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="メールアドレスも発行しますか？"
      size="md"
      testId="participation-issue-mail-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={issue.isPending} testId="participation-issue-mail-later">
            今はしない
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={issue.isPending}
            disabled={!localPart.trim() || stuck}
            testId="participation-issue-mail-submit"
          >
            {issue.isError ? "もう一度発行する" : "発行する"}
          </Button>
        </>
      }
    >
      <div className={styles.resolveBody}>
        <p className={styles.resolveLead}>
          「{participation.name}」を運営メンバーに追加しました。続けて @{MAIL_DOMAIN} のメールアドレスを発行すると、ログイン用アカウントの作成とこの人への紐付けまでまとめて行います。
        </p>
        <FormField
          label="メールアドレス"
          htmlFor="participation-issue-mail-localpart"
          error={issue.isError && !stuck ? errorMessage(issue.error) : undefined}
          help="参加届のローマ字から作った案です。必要なら書き換えてください。"
        >
          <div className={styles.mailRow}>
            <TextField
              id="participation-issue-mail-localpart"
              value={localPart}
              onChange={setLocalPart}
              placeholder="taro.yamada"
              disabled={issue.isPending}
              testId="participation-issue-mail-localpart"
            />
            <span className={styles.mailSuffix}>@{MAIL_DOMAIN}</span>
          </div>
        </FormField>
        <div className={styles.roleFieldset} data-testid="participation-issue-mail-roles">
          <span className={styles.roleLegend}>付くロール</span>
          <p className={styles.resolveLead} data-testid="participation-issue-mail-role-fixed">
            一般メンバー（固定）。チームや役職のロールは、運営メンバーの所属・役職から自動で付きます。
          </p>
        </div>
        {stuck ? (
          <p className={styles.issueError} role="alert" data-testid="participation-issue-mail-stuck">
            途中で失敗し、作成済みの分を元に戻せませんでした。同じアドレスでは再発行できないので、管理者に連絡してください。
          </p>
        ) : null}
        <Checkbox
          id="participation-issue-mail-send"
          checked={sendMail && gmail !== ""}
          onChange={setSendMail}
          disabled={gmail === "" || issue.isPending}
          label={gmail ? `ログイン情報を ${gmail} に送る` : "ログイン情報のメール（Gmail が未登録のため送れません）"}
          testId="participation-issue-mail-send"
        />
      </div>
    </Modal>
  );
}
