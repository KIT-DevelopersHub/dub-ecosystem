// Mail inbox screen. Received messages come from GET /api/v1/mail/messages
// (mail:read) via the shell api-client. Read-only list container (design leaves
// full thread view to a later slice); empty / error / loading states use @dub/ui.
import { useQuery } from "@tanstack/react-query";
import { Button, Card, EmptyState, ErrorState, PageHeader, SkeletonLoader, Stack } from "@dub/ui";
import type { mail } from "@dub/types";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { useMailApi } from "./MailProvider.tsx";

function formatReceived(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

function MessageRow({ message }: { message: mail.MailMessage }): JSX.Element {
  const fromLabel = message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email;
  return (
    <Card testId="fe2-mail-inbox-item">
      <Stack gap={2}>
        <strong>{message.subject || "(件名なし)"}</strong>
        <span>{fromLabel}</span>
        <small>{message.snippet}</small>
        <small>{formatReceived(message.receivedAt)}</small>
      </Stack>
    </Card>
  );
}

export function InboxScreen({ onCompose }: { onCompose?: () => void }): JSX.Element {
  const mailApi = useMailApi();
  const query = useQuery({
    queryKey: queryKeys.feature("mail", "inbox"),
    queryFn: () => mailApi.listInbox({ limit: 50 }),
  });

  const composeAction = onCompose ? (
    <Button testId="fe2-mail-inbox-compose" onClick={onCompose}>
      メール作成
    </Button>
  ) : undefined;

  let body: JSX.Element;
  if (query.isPending) {
    body = <SkeletonLoader lines={5} />;
  } else if (query.isError) {
    const display = ApiError.isApiError(query.error)
      ? toDisplayableError(query.error)
      : { code: "INTERNAL", message: "メールを読み込めませんでした。" };
    body = <ErrorState testId="fe2-mail-inbox-error" error={display} onRetry={() => void query.refetch()} />;
  } else if (query.data.items.length === 0) {
    body = (
      <EmptyState
        testId="fe2-mail-inbox-empty"
        title="受信メールはありません"
        description="新しいメールが届くとここに表示されます。"
        icon="inbox"
        {...(composeAction ? { action: composeAction } : {})}
      />
    );
  } else {
    body = (
      <Stack gap={3}>
        {query.data.items.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
      </Stack>
    );
  }

  return (
    <main data-testid="fe2-mail-inbox">
      <PageHeader title="受信トレイ" {...(composeAction ? { actions: composeAction } : {})} />
      {body}
    </main>
  );
}
