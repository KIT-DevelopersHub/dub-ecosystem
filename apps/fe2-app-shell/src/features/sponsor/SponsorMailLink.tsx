// メール画面 (スレッドの読み取りペイン) の「スポンサー企業に紐付け」。
// 相手のアドレスがどの営業先として数えられるか (紐付け / 担当者メール / 会社ドメイン) を出し、
// sponsor:write のある人は営業先を検索して紐付け (付け替え) できる。紐付けると、そのアドレスとの既存メールから
// 初回連絡日などがすぐ入り、以後のメールも自動で数えられる。
// メール feature はスポンサーの Provider の内側に置かれる (featureModules の adaptMail)。外では何も出さない。
import { useMemo, useState } from "react";
import { Badge, Select } from "@dub/ui";
import { SearchableMenu, type SearchableMenuItem } from "@dub/app-ui";
import { sponsor } from "@dub/types";
import { useOptionalCanEdit } from "../../auth/AuthProvider.tsx";
import { useOptionalSponsorApi } from "./SponsorProvider.tsx";
import { useLeads } from "./leadHooks.ts";
import { useLinkMail, useMailLinks } from "./mailSyncHooks.ts";
import styles from "./SponsorMailLink.module.css";

const HOW: Record<sponsor.MailMatchBy, string> = { link: "紐付け済み", email: "担当者メールと一致", domain: "同じ会社のドメイン" };

/** 社外の相手だけ (自社ドメインを除く・重複なし・出てきた順)。 */
export function externalAddresses(addresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of addresses) {
    const a = sponsor.normalizeAddress(raw);
    if (a && !sponsor.OWN_MAIL_DOMAINS.includes(sponsor.mailDomain(a)) && !out.includes(a)) out.push(a);
  }
  return out;
}

export function SponsorMailLink({ addresses, threadId }: { addresses: readonly string[]; threadId: string }): JSX.Element | null {
  const api = useOptionalSponsorApi();
  const canWrite = useOptionalCanEdit("sponsor", "sponsor:write") ?? false;
  const external = useMemo(() => externalAddresses(addresses), [addresses]);
  if (!api || !canWrite || external.length === 0) return null;
  return <LinkRow addresses={external} threadId={threadId} />;
}

function LinkRow({ addresses, threadId }: { addresses: string[]; threadId: string }): JSX.Element {
  const [address, setAddress] = useState(addresses[0]!);
  const current = addresses.includes(address) ? address : addresses[0]!;
  const leads = useLeads();
  const links = useMailLinks();
  const link = useLinkMail();

  const all = leads.data?.leads ?? [];
  const match = useMemo(
    () => (leads.data && links.data ? sponsor.buildLeadMatcher(leads.data.leads, links.data.links)(current) : null),
    [leads.data, links.data, current],
  );
  const matched = match ? all.find((l) => l.id === match.leadId) ?? null : null;

  const items: SearchableMenuItem[] = useMemo(
    () =>
      [...all]
        .sort((a, b) => a.companyName.localeCompare(b.companyName, "ja"))
        .map((l) => ({
          id: l.id,
          label: l.companyName,
          description: [l.status, l.contactEmail].filter(Boolean).join("・"),
          ...(matched?.id === l.id && match?.by === "link" ? { disabledReason: "紐付け済み" } : {}),
          testId: `fe2-sponsor-mail-link-option-${l.id}`,
        })),
    [all, matched, match],
  );

  return (
    <div className={styles.row} data-testid="fe2-sponsor-mail-link">
      <span className={styles.label}>スポンサー</span>
      {addresses.length > 1 ? (
        <span className={styles.address}>
          <label htmlFor={`sponsor-mail-link-address-${threadId}`} className={styles.label}>
            相手
          </label>{" "}
          <Select<string>
            id={`sponsor-mail-link-address-${threadId}`}
            testId="fe2-sponsor-mail-link-address"
            value={current}
            onChange={setAddress}
            options={addresses.map((a) => ({ value: a, label: a }))}
          />
        </span>
      ) : null}
      {matched && match ? (
        <>
          <Badge tone="success" testId="fe2-sponsor-mail-link-current">
            {matched.companyName}
          </Badge>
          <span className={styles.how} data-testid="fe2-sponsor-mail-link-how">
            {HOW[match.by]}
          </span>
        </>
      ) : null}
      <SearchableMenu
        testId="fe2-sponsor-mail-link-menu"
        label="スポンサー企業に紐付け"
        trigger={matched ? "別の企業に紐付け" : "スポンサー企業に紐付け"}
        heading={`${current} とのメールを数える企業`}
        searchPlaceholder="企業名・メールで検索"
        emptyText="該当する企業がありません"
        loading={leads.isLoading || links.isLoading}
        items={items}
        onSelect={(item) => {
          const lead = all.find((l) => l.id === item.id);
          if (lead) link.mutate({ lead, address: current, threadId });
        }}
      />
    </div>
  );
}
