// Mail compose screen. The former standalone compose Worker required pasting a
// bearer token per send; here the shell session authorizes the call, so there is
// no token field at all. Route-level RequirePermission("mail:send") gates entry;
// this screen focuses on the form. Built entirely from @dub/ui primitives.
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, Card, Form, FormField, PageHeader, Stack, TextField, Textarea, useToast } from "@dub/ui";
import type { mail } from "@dub/types";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { useMailApi } from "./MailProvider.tsx";
import { MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_BYTES, MAX_ATTACHMENT_BYTES, fileToAttachment, formatBytes, parseRecipients } from "./mailApi.tsx";

interface Fields {
  to: string;
  subject: string;
  body: string;
}

interface PickedAttachment {
  filename: string;
  sizeBytes: number;
  input: mail.MailAttachmentInput;
}

function validate(fields: Fields): { req?: mail.SendMailRequest; errors: Partial<Record<keyof Fields, string>> } {
  const errors: Partial<Record<keyof Fields, string>> = {};
  const { recipients, invalid } = parseRecipients(fields.to);
  if (recipients.length === 0) errors.to = "宛先を1件以上入力してください。";
  else if (invalid.length > 0) errors.to = `メールアドレスの形式が正しくありません: ${invalid.join(", ")}`;
  if (fields.subject.trim().length === 0) errors.subject = "件名を入力してください。";
  if (fields.body.trim().length === 0) errors.body = "本文を入力してください。";
  if (Object.keys(errors).length > 0) return { errors };
  return { req: { to: recipients, subject: fields.subject.trim(), textBody: fields.body }, errors };
}

export function ComposeScreen(): JSX.Element {
  const mailApi = useMailApi();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<Fields>({ to: "", subject: "", body: "" });
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const send = useMutation({
    mutationFn: (req: mail.SendMailRequest) => mailApi.send(req),
    onSuccess: () => {
      toast.show({ kind: "success", title: "メールを送信しました。" });
      setFields({ to: "", subject: "", body: "" });
      setAttachments([]);
      setSubmitted(false);
      // Invalidate the Sent list so the just-sent mail shows on arrival (defeats the
      // 30s staleTime after a prior empty visit), then land in the Sent folder.
      void queryClient.invalidateQueries({ queryKey: queryKeys.feature("mail", "sent-list") });
      void navigate({ to: "/mail/sent" });
    },
    onError: (e: unknown) => {
      const message = ApiError.isApiError(e) ? toDisplayableError(e).message : "メールを送信できませんでした。";
      toast.show({ kind: "error", title: message });
    },
  });

  const { req, errors } = validate(fields);
  const set = (k: keyof Fields) => (v: string) => setFields((f) => ({ ...f, [k]: v }));
  const showError = (k: keyof Fields): string | undefined => (submitted ? errors[k] : undefined);

  async function onPickFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return;
    const picked: PickedAttachment[] = [];
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.show({ kind: "error", title: `${file.name} は大きすぎます（上限 ${formatBytes(MAX_ATTACHMENT_BYTES)}）。` });
        continue;
      }
      picked.push({ filename: file.name, sizeBytes: file.size, input: await fileToAttachment(file) });
    }
    setAttachments((prev) => {
      const merged = [...prev, ...picked].slice(0, MAX_ATTACHMENTS);
      const total = merged.reduce((n, a) => n + a.sizeBytes, 0);
      if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
        toast.show({ kind: "error", title: `添付の合計が上限（${formatBytes(MAX_ATTACHMENTS_TOTAL_BYTES)}）を超えています。` });
        return prev;
      }
      return merged;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(idx: number): void {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  function onSubmit(): void {
    setSubmitted(true);
    if (!req) return;
    const full = attachments.length > 0 ? { ...req, attachments: attachments.map((a) => a.input) } : req;
    send.mutate(full);
  }

  return (
    <main data-testid="fe2-mail-compose">
      <PageHeader title="メール作成" />
      <Card>
        <Form testId="fe2-mail-compose-form" onSubmit={onSubmit}>
          <Stack>
            <FormField label="宛先" htmlFor="mail-to" required {...(showError("to") ? { error: showError("to") } : {})} help="カンマ区切りで複数指定できます。">
              <TextField
                id="mail-to"
                testId="fe2-mail-compose-to"
                type="text"
                value={fields.to}
                onChange={set("to")}
                placeholder="alice@example.com, Bob <bob@example.com>"
                {...(showError("to") ? { invalid: true } : {})}
              />
            </FormField>
            <FormField label="件名" htmlFor="mail-subject" required {...(showError("subject") ? { error: showError("subject") } : {})}>
              <TextField
                id="mail-subject"
                testId="fe2-mail-compose-subject"
                value={fields.subject}
                onChange={set("subject")}
                {...(showError("subject") ? { invalid: true } : {})}
              />
            </FormField>
            <FormField label="本文" htmlFor="mail-body" required {...(showError("body") ? { error: showError("body") } : {})}>
              <Textarea
                id="mail-body"
                testId="fe2-mail-compose-body"
                value={fields.body}
                onChange={set("body")}
                rows={10}
                {...(showError("body") ? { invalid: true } : {})}
              />
            </FormField>
            <FormField label="添付ファイル" htmlFor="mail-attach" help={`1ファイル ${formatBytes(MAX_ATTACHMENT_BYTES)} まで・最大 ${MAX_ATTACHMENTS} 件`}>
              <input
                ref={fileInputRef}
                id="mail-attach"
                data-testid="fe2-mail-compose-attach-input"
                type="file"
                multiple
                onChange={(e) => void onPickFiles(e.target.files)}
              />
            </FormField>
            {attachments.length > 0 ? (
              <Stack gap={1} testId="fe2-mail-compose-attach-list">
                {attachments.map((a, i) => (
                  <Stack key={`${a.filename}-${i}`} direction="row" gap={2} align="center">
                    <span data-testid="fe2-mail-compose-attach-name">{a.filename}</span>
                    <small>({formatBytes(a.sizeBytes)})</small>
                    <Button variant="secondary" testId="fe2-mail-compose-attach-remove" onClick={() => removeAttachment(i)}>
                      削除
                    </Button>
                  </Stack>
                ))}
              </Stack>
            ) : null}
            <div>
              <Button testId="fe2-mail-compose-send" type="submit" loading={send.isPending}>
                送信
              </Button>
            </div>
          </Stack>
        </Form>
      </Card>
    </main>
  );
}
