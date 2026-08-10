// Thread detail view (mail:read). Opened from the inbox list: fetches the whole thread
// (GET /api/v1/mail/threads/:id) and renders each message with its full body. Body
// rendering prefers the plain-text part; an HTML-only message is passed through the
// allowlist sanitizer (sanitize.tsx) before it ever touches the DOM. Read/unread is
// shown per message via a Badge; the list marks messages read on open (InboxScreen).
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, Divider, ErrorState, PageHeader, SkeletonLoader, Stack } from "@dub/ui";
import type { mail } from "@dub/types";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { useMailApi } from "./MailProvider.tsx";
import { sanitizeHtml } from "./sanitize.tsx";

function formatReceived(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

function addressLabel(a: mail.MailAddress): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

/** Render one message body. Text is preferred; HTML is sanitized to a safe subset. */
function MessageBody({ message }: { message: mail.MailMessageDetail }): JSX.Element {
  if (message.textBody && message.textBody.trim().length > 0) {
    return (
      <div data-testid="fe2-mail-body-text" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {message.textBody}
      </div>
    );
  }
  if (message.htmlBody) {
    const safe = sanitizeHtml(message.htmlBody);
    // safe is an allowlisted subset produced by sanitize.tsx (no scripts/handlers/js: urls).
    return <div data-testid="fe2-mail-body-html" dangerouslySetInnerHTML={{ __html: safe }} />;
  }
  return <em data-testid="fe2-mail-body-empty">(本文なし)</em>;
}

function MessageCard({ message }: { message: mail.MailMessageDetail }): JSX.Element {
  return (
    <Card testId="fe2-mail-thread-message">
      <Stack gap={2}>
        <Stack direction="row" gap={2} align="center">
          <strong>{addressLabel(message.from)}</strong>
          {!message.read ? <Badge tone="info" testId="fe2-mail-thread-unread">未読</Badge> : null}
        </Stack>
        <small>宛先: {message.to.map(addressLabel).join(", ")}</small>
        <small>{formatReceived(message.receivedAt)}</small>
        <Divider />
        <MessageBody message={message} />
      </Stack>
    </Card>
  );
}

export function ThreadDetail({ threadId, onBack }: { threadId: string; onBack: () => void }): JSX.Element {
  const mailApi = useMailApi();
  const query = useQuery({
    queryKey: queryKeys.feature("mail", "thread", threadId),
    queryFn: () => mailApi.getThread(threadId),
  });

  const back = (
    <Button variant="secondary" testId="fe2-mail-thread-back" onClick={onBack}>
      受信トレイに戻る
    </Button>
  );

  let body: JSX.Element;
  if (query.isPending) {
    body = <SkeletonLoader lines={6} />;
  } else if (query.isError) {
    const display = ApiError.isApiError(query.error)
      ? toDisplayableError(query.error)
      : { code: "INTERNAL", message: "スレッドを読み込めませんでした。" };
    body = <ErrorState testId="fe2-mail-thread-error" error={display} onRetry={() => void query.refetch()} />;
  } else {
    const messages = query.data.messages;
    const subject = messages[0]?.subject || "(件名なし)";
    body = (
      <Stack gap={3}>
        <PageHeader title={subject} actions={back} />
        {messages.map((m) => (
          <MessageCard key={m.id} message={m} />
        ))}
      </Stack>
    );
  }

  return <main data-testid="fe2-mail-thread">{body}</main>;
}
