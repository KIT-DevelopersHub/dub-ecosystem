// 営業先の詳細ドロワーの「メール」欄: 紐付けたアドレス (sponsor:write なら外せる) と、メールからの自動更新の履歴。
// 例: 「メールから自動更新: 2026/11/04 送信 suzuki@developershub.jp → yamada@…」+ 変わった項目。
import { SkeletonList, Tag } from "@dub/ui";
import { sponsor } from "@dub/types";
import { formatOn } from "./leads.ts";
import { useLeadActivity, useMailLinks, useRemoveMailLink } from "./mailSyncHooks.ts";
import { useSponsorCapability } from "./SponsorShared.tsx";
import styles from "./sponsor.module.css";

const FIELD_LABEL: Record<sponsor.MailSyncField, string> = { status: "ステータス", firstContactOn: "初回連絡日", lastContactOn: "最終接触日" };
const SOURCE_LABEL: Record<sponsor.MailSyncSource, string> = { live: "メールから自動更新", link: "紐付けたメールから更新", backfill: "既存メールから補完" };
const MATCH_LABEL: Record<sponsor.MailMatchBy, string> = { link: "紐付け", email: "担当者メール", domain: "同じドメイン" };

const value = (c: sponsor.LeadFieldChange, v: string | null): string => (v === null ? "—" : c.field === "status" ? v : formatOn(v));

export function describeActivity(a: sponsor.LeadActivity): { title: string; route: string; changes: string[] } {
  const on = formatOn(sponsor.jstDate(a.mailAt));
  const verb = a.direction === "sent" ? "送信" : "受信";
  const route = a.direction === "sent" ? `${a.mailbox ?? "Dub"} → ${a.counterpart}` : `${a.counterpart} → ${a.mailbox ?? "Dub"}`;
  return {
    title: `${SOURCE_LABEL[a.source]}: ${on} ${verb}`,
    route: `${route}（${MATCH_LABEL[a.matchedBy]}で一致）`,
    changes: a.changes.map((c) => `${FIELD_LABEL[c.field]} ${value(c, c.from)} → ${value(c, c.to)}`),
  };
}

export function LeadMailSection({ leadId }: { leadId: string }): JSX.Element {
  const { canWrite } = useSponsorCapability();
  const activity = useLeadActivity(leadId);
  const links = useMailLinks();
  const unlink = useRemoveMailLink();
  const mine = (links.data?.links ?? []).filter((l) => l.leadId === leadId);
  const items = activity.data?.activity ?? [];

  return (
    <div className={styles.detailSection} data-testid="fe2-sponsor-lead-mail">
      <h3 className={styles.leadSectionTitle}>メール</h3>
      <p className={styles.note}>Dub のメールでこの企業とやり取りすると、初回連絡日・最終接触日とステータスが自動で進みます。</p>
      {mine.length > 0 ? (
        <div className={styles.inlineActions} data-testid="fe2-sponsor-lead-mail-links">
          {mine.map((l) => (
            <Tag key={l.id} testId={`fe2-sponsor-lead-mail-link-${l.address}`} {...(canWrite ? { onRemove: () => unlink.mutate(l) } : {})}>
              {l.address}
            </Tag>
          ))}
        </div>
      ) : null}
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
