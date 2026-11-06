// メール画面 (スレッドの読み取りペイン) の「スポンサー」行。
// 営業進捗が自動で進むのは「登録したアドレス」(営業先の担当者メール・その会社の名刺のメール) とのメールだけ。
// この行は相手のアドレスが登録済みか (どの企業の担当者メール / 名刺か) を出し、sponsor:write のある人は
// 営業先を検索して「担当者メールに登録」できる。登録すると、そのアドレスとの既存メールから日付がすぐ入る。
// メール feature はスポンサーの Provider の内側に置かれる (featureModules の adaptMail)。外では何も出さない。
import { useMemo, useState } from "react";
import { Badge, Select } from "@dub/ui";
import { SearchableMenu, type SearchableMenuItem } from "@dub/app-ui";
import { sponsor } from "@dub/types";
import { useOptionalCanEdit } from "../../auth/AuthProvider.tsx";
import { useOptionalSponsorApi } from "./SponsorProvider.tsx";
import { useLeads } from "./leadHooks.ts";
import { useCards } from "./sponsorHooks.ts";
import { useRegisterContactEmail } from "./mailSyncHooks.ts";
import styles from "./SponsorMailLink.module.css";

const HOW: Record<sponsor.MailMatchBy, string> = { contact: "担当者メールに登録済み", card: "名刺に登録済み" };

/** 社外の相手だけ (自社ドメインを除く・重複なし・出てきた順)。 */
export function externalAddresses(addresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of addresses) {
    const a = sponsor.normalizeAddress(raw);
    if (a && sponsor.isExternalAddress(a) && !out.includes(a)) out.push(a);
  }
  return out;
}

export function SponsorMailLink({ addresses, threadId }: { addresses: readonly string[]; threadId: string }): JSX.Element | null {
  const api = useOptionalSponsorApi();
  const canWrite = useOptionalCanEdit("sponsor", "sponsor:write") ?? false;
  const external = useMemo(() => externalAddresses(addresses), [addresses]);
  if (!api || !canWrite || external.length === 0) return null;
  return <RegisterRow addresses={external} threadId={threadId} />;
}

function RegisterRow({ addresses, threadId }: { addresses: string[]; threadId: string }): JSX.Element {
  const [address, setAddress] = useState(addresses[0]!);
  const current = addresses.includes(address) ? address : addresses[0]!;
  const leads = useLeads();
  const cards = useCards();
  const register = useRegisterContactEmail();

  const all = leads.data?.leads ?? [];
  const match = useMemo(
    () => (leads.data && cards.data ? sponsor.buildLeadMatcher(leads.data.leads, cards.data.cards)(current) : null),
    [leads.data, cards.data, current],
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
          ...(matched?.id === l.id ? { disabledReason: HOW[match!.by] } : {}),
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
      ) : (
        <span className={styles.how} data-testid="fe2-sponsor-mail-link-how">
          未登録のアドレス（このメールは営業進捗に数えません）
        </span>
      )}
      <SearchableMenu
        testId="fe2-sponsor-mail-link-menu"
        label="企業の担当者メールに登録"
        trigger={matched ? "別の企業に登録" : "企業の担当者メールに登録"}
        heading={`${current} を担当者メールに登録する企業`}
        searchPlaceholder="企業名・メールで検索"
        emptyText="該当する企業がありません"
        loading={leads.isLoading || cards.isLoading}
        items={items}
        onSelect={(item) => {
          const lead = all.find((l) => l.id === item.id);
          if (lead) register.mutate({ lead, address: current });
        }}
      />
    </div>
  );
}
