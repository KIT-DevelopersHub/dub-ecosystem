// アカウント発行メール prompt for the メール名簿 side. Wraps the shared @dub/app-ui
// AccountMailDialog with fe7's send mutation + toast. Shown only when the linked member
// has a Gmail (the caller decides by passing a target or null).
import { useEffect } from "react";
import { AccountMailDialog, isDevhubAddress } from "@dub/app-ui";
import type { member } from "@dub/types";
import type { RosterUser } from "../contracts/pending";
import { useSendAccountMail } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { presentError } from "../lib/errorDisplay";

type MailAccount = Pick<RosterUser, "id" | "email">;

export interface AccountMailTarget {
  member: member.Member;
  account: MailAccount;
}

/** What is still missing before the mail can be sent (empty = ready). */
export function accountMailMissing(m: member.Member | null | undefined, account: MailAccount): string[] {
  const missing: string[] = [];
  if (!isDevhubAddress(account.email)) missing.push("ログインメールが @developershub.jp のアドレスではありません");
  if (!m) missing.push("運営メンバーと紐付いていません");
  else if (!(m.gmail ?? "").trim()) missing.push("運営メンバーの Gmail が登録されていません");
  return missing;
}

/** Only when Gmail + login + @developershub.jp address are all linked — otherwise no prompt. */
export function accountMailTargetOf(m: member.Member | null | undefined, account: MailAccount): AccountMailTarget | null {
  return m && accountMailMissing(m, account).length === 0 ? { member: m, account } : null;
}

export function AccountMailPrompt({ target, onClose }: { target: AccountMailTarget | null; onClose: () => void }): JSX.Element | null {
  const send = useSendAccountMail();
  const { toast } = useToast();
  const { reset } = send;
  useEffect(() => reset(), [target?.account.id, reset]);

  if (!target) return null;
  const p = send.isError ? presentError(send.error) : null;
  const error = p ? ("message" in p ? p.message : "アカウント発行メールを送れませんでした") : null;
  return (
    <AccountMailDialog
      open
      name={target.member.name}
      to={(target.member.gmail ?? "").trim()}
      cc={target.account.email}
      sending={send.isPending}
      error={error}
      onSend={() =>
        send.mutate(target.account.id, {
          onSuccess: (res) => {
            toast({ kind: "success", title: `${res.to} にアカウント発行メールを送りました` });
            onClose();
          },
        })
      }
      onClose={onClose}
      testId="fe7-account-mail-dialog"
    />
  );
}
