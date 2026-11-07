// 営業先の詳細ドロワーの「メール」欄: 数えるアドレス (担当者メール・名刺のメール) と、メールからの自動更新の履歴。
// 例: 「メールから自動更新: 2026/11/04 送信 suzuki@… → yamada@…（担当者メール）」+ 変わった項目。
import { SkeletonList, Tag } from "@dub/ui";
import { sponsor } from "@dub/types";
import { formatOn } from "./leads.ts";
import { useLeadActivity } from "./mailSyncHooks.ts";
import { useCards } from "./sponsorHooks.ts";
import styles from "./sponsor.module.css";

const FIELD_LABEL: Record<sponsor.MailSyncField, string> = { status: "ステータス", firstContactOn: "初回連絡日", lastContactOn: "最終接触日" };
const SOURCE_LABEL: Record<sponsor.MailSyncSource, string> = { live: "メールから自動更新", register: "登録したアドレスのメールから更新", backfill: "既存メールから補完" };
export const MATCH_LABEL: Record<sponsor.MailMatchBy, string> = { contact: "担当者メール", card: "名刺" };

/** 画面に出すルールの説明 (詳細・一括補完で同じ文)。 */
export const MAIL_RULE_TEXT = "名刺または担当者メールに登録したアドレスとのメールだけを数えます。同じ会社でも登録していないアドレスは数えません。";

const value = (c: sponsor.LeadFieldChange, v: string | null): string => (v === null ? "—" : c.field === "status" ? v : formatOn(v));

export function describeActivity(a: sponsor.LeadActivity): { title: string; route: string; changes: string[] } {
  const on = formatOn(sponsor.jstDate(a.mailAt));
  const verb = a.direction === "sent" ? "送信" : "受信";
  const route = a.direction === "sent" ? `${a.mailbox ?? "Dub"} → ${a.counterpart}` : `${a.counterpart} → ${a.mailbox ?? "Dub"}`;
  return {
    title: `${SOURCE_LABEL[a.source]}: ${on} ${verb}`,
    route: `${route}（${MATCH_LABEL[a.matchedBy]}に登録済み）`,
    changes: a.changes.map((c) => `${FIELD_LABEL[c.field]} ${value(c, c.from)} → ${value(c, c.to)}`),
  };
}

export function LeadMailSection({ lead }: { lead: sponsor.SponsorLead }): JSX.Element {
  const activity = useLeadActivity(lead.id);
  const cards = useCards();
  const registered = sponsor.registeredAddresses(lead, cards.data?.cards ?? []);
  const items = activity.data?.activity ?? [];

  return (
    <div className={styles.detailSection} data-testid="fe2-sponsor-lead-mail">
      <h3 className={styles.leadSectionTitle}>メール</h3>
      <p className={styles.note} data-testid="fe2-sponsor-lead-mail-rule">
        Dub のメールで送受信すると、初回連絡日・最終接触日とステータスが自動で進みます。{MAIL_RULE_TEXT}
      </p>
      {registered.length > 0 ? (
        <div className={styles.inlineActions} data-testid="fe2-sponsor-lead-mail-addresses">
          {registered.map((r) => (
            <Tag key={r.address} testId={`fe2-sponsor-lead-mail-address-${r.address}`}>
              {r.address}（{MATCH_LABEL[r.by]}）
            </Tag>
          ))}
        </div>
      ) : (
        <p className={styles.note} data-testid="fe2-sponsor-lead-mail-none">
          まだ登録したアドレスがありません。担当者メールを入れるか、この企業の名刺を登録してください。
        </p>
      )}
      {activity.isLoading ? (
        <SkeletonList rows={2} testId="fe2-sponsor-lead-activity-loading" />
      ) : items.length > 0 ? (
        <ul className={styles.activityList} data-testid="fe2-sponsor-lead-activity">
          {items.map((a) => {
            const d = describeActivity(a);
            return (
              <li key={a.id} className={styles.activityItem} data-testid="fe2-sponsor-lead-activity-item">
                <strong>{d.title}</strong>
                <span className={styles.note}>{d.route}</span>
                <span>{d.changes.join("、")}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
