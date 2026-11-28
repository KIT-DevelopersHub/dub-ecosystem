// #942 自分の受信箱 ⇄ 自分の班・チームのメンバーの受信箱 (読み取り専用)。候補はサーバが決めた範囲
// (GET /mail/managed-mailboxes) だけで、空なら何も出さない。見ている間は帯で「誰のメールを・読み取り
// 専用で・閲覧が記録される」ことを出し続ける。
import { Button, SearchableSelect } from "@dub/ui";
import type { mail } from "@dub/types";
import styles from "./MailboxSwitcher.module.css";

const SELF = "__self__";
const GROUP: Record<mail.MailManagedRelation, string> = { squad: "班のメンバー", team: "チームのメンバー" };

export interface MailboxSwitcherProps {
  mailboxes: mail.MailManagedMailbox[];
  viewing: mail.MailManagedMailbox | null;
  onChange: (next: mail.MailManagedMailbox | null) => void;
}

export function MailboxSwitcher({ mailboxes, viewing, onChange }: MailboxSwitcherProps): JSX.Element | null {
  if (mailboxes.length === 0 && !viewing) return null;
  const options = [
    { value: SELF, label: "自分の受信箱", testId: "fe2-mail-mailbox-option-self" },
    ...mailboxes.map((m) => ({ value: m.userId, label: m.name, group: GROUP[m.relation], testId: `fe2-mail-mailbox-option-${m.userId}` })),
  ];
  return (
    <>
      <div className={styles.switcher} data-testid="fe2-mail-mailbox-switcher">
        <span className={styles.label}>
          受信箱
        </span>
        <div className={styles.picker}>
          <SearchableSelect
            id="fe2-mail-mailbox"
            aria-label="表示する受信箱"
            testId="fe2-mail-mailbox-select"
            value={viewing?.userId ?? SELF}
            options={options}
            searchPlaceholder="メンバーを検索"
            onChange={(v) => onChange(v === SELF ? null : (mailboxes.find((m) => m.userId === v) ?? null))}
          />
        </div>
      </div>
      {viewing ? (
        <div role="status" className={styles.banner} data-testid="fe2-mail-viewing-banner">
          <span className={styles.bannerText}>
            {viewing.name} さんのメールを閲覧中です（読み取り専用）。送信・返信・既読や整理の変更はできません。閲覧したことは記録されます。
          </span>
          <Button variant="secondary" size="sm" testId="fe2-mail-viewing-exit" onClick={() => onChange(null)}>
            自分の受信箱に戻る
          </Button>
        </div>
      ) : null}
    </>
  );
}
