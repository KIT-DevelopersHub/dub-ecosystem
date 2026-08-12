// Mail Sent screen (mail:read). Lists delivered outbound mail (GET /api/v1/mail/sent)
// newest-first and drives a master→detail flow: selecting a row opens the sent message
// detail (GET /api/v1/mail/sent/:id) with its full body. Mirrors InboxScreen's layout
// and @dub/ui usage so Inbox / Sent read as one mailbox; the MailFolderTabs header
// switches between the two folders. Empty / error / loading use @dub/ui.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Badge, Button, Card, Divider, EmptyState, ErrorState, PageHeader, SkeletonLoader, Stack, useToast } from "@dub/ui";
import type { mail } from "@dub/types";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { useMailApi } from "./MailProvider.tsx";
import { MailFolderTabs } from "./MailFolderTabs.tsx";
import { sanitizeHtml } from "./sanitize.tsx";
import { formatBytes, saveBlob } from "./mailApi.tsx";

function formatSent(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

function addressLabel(a: mail.MailAddress): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

function recipientsLabel(item: mail.MailSentListItem): string {
  const to = item.to.map(addressLabel).join(", ");
  return to.length > 0 ? to : "(宛先なし)";
}

function SentRow({ item, onOpen }: { item: mail.MailSentListItem; onOpen: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-testid="fe2-mail-sent-item"
      onClick={onOpen}
      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}
      aria-label={`${item.subject || "(件名なし)"} — 宛先 ${recipientsLabel(item)}`}
    >
      <Card>
        <Stack gap={2}>
          <strong>{item.subject || "(件名なし)"}</strong>
          <span>宛先: {recipientsLabel(item)}</span>
          <small>{item.snippet}</small>
          <small>{formatSent(item.sentAt)}</small>
        </Stack>
      </Card>
    </button>
  );
}

/** Render one sent message body. Text is preferred; HTML is sanitized to a safe subset. */
function SentBody({ message }: { message: mail.MailSentDetail }): JSX.Element {
  if (message.textBody && message.textBody.trim().length > 0) {
    return (
      <div data-testid="fe2-mail-sent-body-text" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {message.textBody}
      </div>
    );
  }
  if (message.htmlBody) {
    const safe = sanitizeHtml(message.htmlBody);
    return <div data-testid="fe2-mail-sent-body-html" dangerouslySetInnerHTML={{ __html: safe }} />;
  }
  return <em data-testid="fe2-mail-sent-body-empty">(本文なし)</em>;
}

function SentDetail({ id, onBack }: { id: string; onBack: () => void }): JSX.Element {
  const mailApi = useMailApi();
  const toast = useToast();
  const query = useQuery({
    queryKey: queryKeys.feature("mail", "sent", id),
    queryFn: () => mailApi.getSent(id),
  });
  const download = async (att: mail.MailAttachment): Promise<void> => {
    try {
      const blob = await mailApi.downloadAttachment("sent", id, att.id);
      saveBlob(blob, att.filename);
    } catch {
      toast.show({ kind: "error", title: "添付ファイルをダウンロードできませんでした。" });
    }
  };

  const back = (
    <Button variant="secondary" testId="fe2-mail-sent-back" onClick={onBack}>
      送信済みに戻る
    </Button>
  );

  let body: JSX.Element;
  if (query.isPending) {
    body = <SkeletonLoader lines={6} />;
  } else if (query.isError) {
    const display = ApiError.isApiError(query.error)
      ? toDisplayableError(query.error)
      : { code: "INTERNAL", message: "送信メールを読み込めませんでした。" };
    body = <ErrorState testId="fe2-mail-sent-detail-error" error={display} onRetry={() => void query.refetch()} />;
  } else {
    const m = query.data;
    body = (
      <Stack gap={3}>
        <PageHeader title={m.subject || "(件名なし)"} actions={back} />
        <Card testId="fe2-mail-sent-message">
          <Stack gap={2}>
            <Stack direction="row" gap={2} align="center">
              <Badge tone="neutral" testId="fe2-mail-sent-badge">送信済み</Badge>
              {m.from ? <strong>{addressLabel(m.from)}</strong> : null}
            </Stack>
            <small>宛先: {m.to.map(addressLabel).join(", ") || "(宛先なし)"}</small>
            {m.cc && m.cc.length > 0 ? <small>Cc: {m.cc.map(addressLabel).join(", ")}</small> : null}
            <small>{formatSent(m.sentAt)}</small>
            <Divider />
            <SentBody message={m} />
            {m.attachments && m.attachments.length > 0 ? (
              <Stack gap={1} testId="fe2-mail-sent-attachments">
                <small>添付ファイル ({m.attachments.length})</small>
                {m.attachments.map((a) => (
                  <Button key={a.id} variant="secondary" testId="fe2-mail-sent-attachment" onClick={() => void download(a)}>
                    {a.filename} ({formatBytes(a.sizeBytes)})
                  </Button>
                ))}
              </Stack>
            ) : null}
          </Stack>
        </Card>
      </Stack>
    );
  }

  return <main data-testid="fe2-mail-sent-detail">{body}</main>;
}

export function SentScreen(): JSX.Element {
  const mailApi = useMailApi();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sentKey = queryKeys.feature("mail", "sent-list");
  const composeAction = (
    <Button testId="fe2-mail-sent-compose" onClick={() => void navigate({ to: "/mail/compose" })}>
      メール作成
    </Button>
  );

  const query = useQuery({
    queryKey: sentKey,
    queryFn: () => mailApi.listSent({ limit: 50 }),
  });

  if (selectedId) {
    return <SentDetail id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  let body: JSX.Element;
  if (query.isPending) {
    body = <SkeletonLoader lines={5} />;
  } else if (query.isError) {
    const display = ApiError.isApiError(query.error)
      ? toDisplayableError(query.error)
      : { code: "INTERNAL", message: "送信メールを読み込めませんでした。" };
    body = <ErrorState testId="fe2-mail-sent-error" error={display} onRetry={() => void query.refetch()} />;
  } else if (query.data.items.length === 0) {
    body = (
      <EmptyState
        testId="fe2-mail-sent-empty"
        title="送信済みメールはありません"
        description="メールを送信するとここに表示されます。"
        icon="inbox"
      />
    );
  } else {
    body = (
      <Stack gap={3}>
        {query.data.items.map((m) => (
          <SentRow key={m.id} item={m} onOpen={() => setSelectedId(m.id)} />
        ))}
      </Stack>
    );
  }

  return (
    <main data-testid="fe2-mail-sent">
      <PageHeader title="送信済み" actions={composeAction} />
      <MailFolderTabs active="sent" />
      {body}
    </main>
  );
}
