// Mail compose screen. The former standalone compose Worker required pasting a
// bearer token per send; here the shell session authorizes the call, so there is
// no token field at all. Route-level RequirePermission("mail:send") gates entry;
// this screen focuses on the form. Built entirely from @dub/ui primitives.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, Card, Form, FormField, PageHeader, Stack, TextField, Textarea, useToast } from "@dub/ui";
import type { mail } from "@dub/types";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { useMailApi } from "./MailProvider.tsx";
import { parseRecipients } from "./mailApi.tsx";

interface Fields {
  to: string;
  subject: string;
  body: string;
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
  const [submitted, setSubmitted] = useState(false);

  const send = useMutation({
    mutationFn: (req: mail.SendMailRequest) => mailApi.send(req),
    onSuccess: () => {
      toast.show({ kind: "success", title: "メールを送信しました。" });
      setFields({ to: "", subject: "", body: "" });
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

  function onSubmit(): void {
    setSubmitted(true);
    if (req) send.mutate(req);
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
