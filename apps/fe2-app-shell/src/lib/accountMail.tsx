// アカウント発行メール prompt for the fe2 screens that link an 運営メンバー to a login
// (運営名簿 / 参加届). Wraps the shared @dub/app-ui AccountMailDialog with the send mutation
// + toast; each feature passes its own api's sendAccountMail so features stay decoupled.
import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { AccountMailDialog, isDevhubAddress } from "@dub/app-ui";
import type { auth } from "@dub/types";
import { ApiError, toDisplayableError } from "./api-client.tsx";

export interface AccountMailTarget {
  identityUserId: string;
  name: string;
  /** member.gmail (宛先). */
  gmail: string;
  /** the @developershub.jp login (CC). */
  devhubEmail: string;
}

/** Build a target only when Gmail + login + @developershub.jp address are all linked. */
export function accountMailTarget(
  identityUserId: string | null | undefined,
  name: string,
  gmail: string | null | undefined,
  devhubEmail: string | null | undefined,
): AccountMailTarget | null {
  const to = (gmail ?? "").trim();
  if (!identityUserId || !to || !isDevhubAddress(devhubEmail)) return null;
  return { identityUserId, name, gmail: to, devhubEmail: devhubEmail.trim() };
}

export function AccountMailPrompt({
  target,
  send,
  onClose,
}: {
  target: AccountMailTarget | null;
  send: (identityUserId: string) => Promise<auth.AdminSendAccountMailResponse>;
  onClose: () => void;
}): JSX.Element | null {
  const toast = useToast();
  const mutation = useMutation<auth.AdminSendAccountMailResponse, unknown, string>({
    mutationFn: (id) => send(id),
    onSuccess: (res) => {
      toast.show({ kind: "success", title: `${res.to} にアカウント発行メールを送りました` });
      onClose();
    },
  });
  const { reset } = mutation;
  useEffect(() => reset(), [target?.identityUserId, reset]);

  if (!target) return null;
  const error = mutation.isError
    ? ApiError.isApiError(mutation.error)
      ? toDisplayableError(mutation.error).message
      : "アカウント発行メールを送れませんでした"
    : null;
  return (
    <AccountMailDialog
      open
      name={target.name}
      to={target.gmail}
      cc={target.devhubEmail}
      sending={mutation.isPending}
      error={error}
      onSend={() => mutation.mutate(target.identityUserId)}
      onClose={onClose}
    />
  );
}
