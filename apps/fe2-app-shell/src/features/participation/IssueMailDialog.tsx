// 参加届を運営メンバーに追加した直後に出す「メールアドレスも発行しますか？」ダイアログ。
// 発行する = @developershub.jp アドレス発行 → ログインアカウント作成(ロール付与) → 名簿と紐付け
// を一続きで行う。後でユーザー名簿から別作業にすると、どのロールを付けるか忘れるため。
// 途中で失敗したら済んだ段を覚えておき、再実行は続きからやり直す (二重発行しない)。
import { useState } from "react";
import { Button, Checkbox, FormField, Modal, SkeletonLoader, TextField } from "@dub/ui";
import type { identity } from "@dub/types";
import { useIssueParticipationMail, useParticipationRoles, type MailIssueProgress, type MailIssueStep } from "./hooks.ts";
import type { Participation, RosterMember } from "./contracts.ts";
import styles from "./participation.module.css";

export const MAIL_DOMAIN = "developershub.jp";
/** 何も選ばずに済むよう、一般メンバーのロールを最初から選んでおく。 */
const DEFAULT_ROLE_IDS = new Set(["role_sys_member", "role_member"]);

const STEP_LABEL: Record<MailIssueStep, string> = {
  mail: "アドレスの発行",
  account: "ログインアカウントの作成",
  link: "運営メンバーとの紐付け",
};

function furiganaOf(p: Participation): string | undefined {
  const kana = [p.lastNameKana, p.firstNameKana].map((v) => (v ?? "").trim()).filter(Boolean).join(" ");
  return kana || undefined;
}

export function IssueMailDialog({
  participation,
  member,
  defaultLocalPart,
  onClose,
  onIssued,
}: {
  participation: Participation;
  member: RosterMember;
  defaultLocalPart: string;
  onClose: () => void;
  /** 3段すべて済んだ後 (このダイアログを閉じる代わりに呼ぶ)。アカウント発行メールへ続ける。 */
  onIssued?: (progress: MailIssueProgress) => void;
}): JSX.Element {
  const [localPart, setLocalPart] = useState(defaultLocalPart);
  const [roleIds, setRoleIds] = useState<string[] | null>(null);
  const [progress, setProgress] = useState<MailIssueProgress>({});
  const [failed, setFailed] = useState<{ step: MailIssueStep; message: string } | null>(null);
  const rolesQuery = useParticipationRoles(true);
  const issue = useIssueParticipationMail();

  const roles = rolesQuery.data ?? [];
  // ロール一覧が届くまでは既定選択を決めない (届いた時点の一般メンバーを選ぶ)。
  const selected = roleIds ?? roles.filter((r) => DEFAULT_ROLE_IDS.has(r.id) || r.name === "member").map((r) => r.id);
  const toggleRole = (id: string, on: boolean): void =>
    setRoleIds(on ? [...selected, id] : selected.filter((x) => x !== id));

  const resuming = progress.address !== undefined;
  const submit = (): void => {
    setFailed(null);
    issue.mutate(
      {
        memberId: member.id,
        memberVersion: member.version,
        localPart: localPart.trim().toLowerCase(),
        displayName: participation.name,
        furigana: furiganaOf(participation),
        roleIds: selected,
        progress,
      },
      {
        onSuccess: (res) => (onIssued ? onIssued(res) : onClose()),
        onError: (err) => {
          setProgress(err.progress);
          setFailed({ step: err.step, message: err.message });
        },
      },
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
            {resuming ? "閉じる（続きはユーザー名簿で）" : "今はしない"}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={issue.isPending}
            disabled={!localPart.trim() || rolesQuery.isLoading}
            testId="participation-issue-mail-submit"
          >
            {resuming ? "続きから再試行" : "発行する"}
          </Button>
        </>
      }
    >
      <div className={styles.resolveBody}>
        <p className={styles.resolveLead}>
          「{participation.name}」を運営メンバーに追加しました。続けて @{MAIL_DOMAIN} のメールアドレスを発行すると、ログイン用アカウントの作成・ロールの付与・この人への紐付けまでまとめて行います。
        </p>
        <FormField
          label="メールアドレス"
          htmlFor="participation-issue-mail-localpart"
          error={failed?.step === "mail" ? failed.message : undefined}
          help="参加届のローマ字から作った案です。必要なら書き換えてください。"
        >
          <div className={styles.mailRow}>
            <TextField
              id="participation-issue-mail-localpart"
              value={localPart}
              onChange={setLocalPart}
              placeholder="taro.yamada"
              disabled={resuming}
              testId="participation-issue-mail-localpart"
            />
            <span className={styles.mailSuffix}>@{MAIL_DOMAIN}</span>
          </div>
        </FormField>
        <fieldset className={styles.roleFieldset} data-testid="participation-issue-mail-roles">
          <legend className={styles.roleLegend}>付けるロール</legend>
          {rolesQuery.isLoading ? (
            <SkeletonLoader testId="participation-issue-mail-roles-loading" />
          ) : rolesQuery.isError ? (
            <p className={styles.resolveLead}>ロール一覧を読み込めませんでした。ロールなしで発行し、あとでユーザー名簿で付けることもできます。</p>
          ) : (
            <div className={styles.roleList}>
              {roles.map((r: identity.Role) => (
                <Checkbox
                  key={r.id}
                  id={`participation-issue-mail-role-${r.id}`}
                  checked={selected.includes(r.id)}
                  onChange={(on) => toggleRole(r.id, on)}
                  disabled={progress.identityUserId !== undefined}
                  label={r.name}
                  testId={`participation-issue-mail-role-${r.id}`}
                />
              ))}
            </div>
          )}
        </fieldset>
        {failed && failed.step !== "mail" ? (
          <p className={styles.issueError} role="alert" data-testid="participation-issue-mail-error">
            {progress.address} は発行済みです。{STEP_LABEL[failed.step]}に失敗しました（{failed.message}）。「続きから再試行」で残りだけやり直せます。
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
