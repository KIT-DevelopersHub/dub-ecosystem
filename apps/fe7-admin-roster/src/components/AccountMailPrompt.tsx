// アカウント発行メール prompt for the メール名簿 side. Wraps the shared @dub/app-ui
// AccountMailDialog with fe7's send mutation + toast. Shown only when the linked member
// has a Gmail (the caller decides by passing a target or null).
import { useEffect } from "react";
import { AccountMailDialog } from "@dub/app-ui";
import type { member } from "@dub/types";
import type { RosterUser } from "../contracts/pending";
import { useSendAccountMail } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { presentError } from "../lib/errorDisplay";

export interface AccountMailTarget {
  member: member.Member;
  account: RosterUser;
}

/** Only a member with a Gmail can receive the mail — otherwise no prompt. */
export function accountMailTargetOf(m: member.Member | null | undefined, account: RosterUser): AccountMailTarget | null {
  return m && (m.gmail ?? "").trim() ? { member: m, account } : null;
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
