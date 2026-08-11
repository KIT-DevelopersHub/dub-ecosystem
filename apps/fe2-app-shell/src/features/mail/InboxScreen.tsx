// Mail inbox screen (mail:read). Lists received messages (GET /api/v1/mail/messages)
// with an unread badge, and drives a master→detail flow: selecting a row opens the
// thread detail (ThreadDetail) and marks that message read (POST …/read), then
// invalidates the list so the badge clears. Empty / error / loading use @dub/ui.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, SkeletonLoader, Stack } from "@dub/ui";
import type { mail } from "@dub/types";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { useMailApi } from "./MailProvider.tsx";
import { MailFolderTabs } from "./MailFolderTabs.tsx";
import { ThreadDetail } from "./MessageDetail.tsx";

function formatReceived(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

function MessageRow({ message, onOpen }: { message: mail.MailMessageListItem; onOpen: () => void }): JSX.Element {
  const fromLabel = message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email;
  return (
    <button
      type="button"
      data-testid="fe2-mail-inbox-item"
      onClick={onOpen}
      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}
      aria-label={`${message.subject || "(件名なし)"} — ${message.read ? "既読" : "未読"}`}
    >
      <Card>
        <Stack gap={2}>
          <Stack direction="row" gap={2} align="center">
            <strong style={{ fontWeight: message.read ? 400 : 700 }}>{message.subject || "(件名なし)"}</strong>
            {!message.read ? <Badge tone="info" testId="fe2-mail-inbox-unread">未読</Badge> : null}
          </Stack>
          <span>{fromLabel}</span>
          <small>{message.snippet}</small>
          <small>{formatReceived(message.receivedAt)}</small>
        </Stack>
      </Card>
    </button>
  );
}

export function InboxScreen({ onCompose }: { onCompose?: () => void }): JSX.Element {
  const mailApi = useMailApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<{ id: string; threadId: string } | null>(null);
  const inboxKey = queryKeys.feature("mail", "inbox");
  // When mounted as a route (no onCompose prop), the compose button navigates to the
  // standalone compose route (mail:send). An embedding parent can still override it.
  const compose = onCompose ?? (() => void navigate({ to: "/mail/compose" }));

  const query = useQuery({
    queryKey: inboxKey,
    queryFn: () => mailApi.listInbox({ limit: 50 }),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => mailApi.markRead(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: inboxKey }),
  });

  const openMessage = (m: mail.MailMessageListItem): void => {
    setSelected({ id: m.id, threadId: m.threadId });
    if (!m.read) markRead.mutate(m.id);
  };

  // Detail takes over the surface; "back" returns to the list (already invalidated).
  if (selected) {
    return <ThreadDetail threadId={selected.threadId} onBack={() => setSelected(null)} />;
  }

  const composeAction = (
    <Button testId="fe2-mail-inbox-compose" onClick={compose}>
      メール作成
    </Button>
  );

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
          <MessageRow key={m.id} message={m} onOpen={() => openMessage(m)} />
        ))}
      </Stack>
    );
  }

  return (
    <main data-testid="fe2-mail-inbox">
      <PageHeader title="受信トレイ" {...(composeAction ? { actions: composeAction } : {})} />
      <MailFolderTabs active="inbox" />
      {body}
    </main>
  );
}
