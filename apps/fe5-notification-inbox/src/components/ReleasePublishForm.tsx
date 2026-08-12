// ReleasePublishForm — admin surface to publish a "🎉 new feature" release note that
// broadcasts to every user's inbox (type=release). Minimal MVP form; the admin gate is
// enforced server-side (notif:admin), so this only renders where the shell grants it.

import { useState, type ReactNode } from "react";
import { Button, Form, FormField, TextField, Textarea } from "@dub/ui";
import { useNotificationDeps } from "../context";
import { isApiError } from "../contracts/fe2";

export interface ReleasePublishFormProps {
  /** Called after a successful publish (e.g. to refetch the inbox). */
  onPublished?: (notificationId: string) => void;
}

export function ReleasePublishForm(props: ReleasePublishFormProps): ReactNode {
  const { api, toast } = useNotificationDeps();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [app, setApp] = useState("");
  const [busy, setBusy] = useState(false);

  const canSubmit = title.trim().length > 0 && body.trim().length > 0 && !busy;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await api.publishRelease({
        title: title.trim(),
        body: body.trim(),
        ...(app.trim() ? { app: app.trim() } : {}),
      });
      toast.show(
        "success",
        res.deduplicated ? "このお知らせは既に配信済みです" : "新機能のお知らせを全員に配信しました",
      );
      setTitle("");
      setBody("");
      setApp("");
      props.onPublished?.(res.notificationId);
    } catch (err) {
      const msg = isApiError(err) ? `配信に失敗しました (${err.code})` : "配信に失敗しました";
      toast.show("error", msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="fe5-release-publish">
      <h2>🎉 新機能のお知らせを配信</h2>
      <Form onSubmit={submit}>
        <FormField label="機能名（タイトル）" htmlFor="release-title" required>
          <TextField
            id="release-title"
            value={title}
            onChange={setTitle}
            placeholder="🎉 ガントチャートを追加しました"
            disabled={busy}
          />
        </FormField>
        <FormField label="説明（このボタンでこれができる、の要約）" htmlFor="release-body" required>
          <Textarea
            id="release-body"
            value={body}
            onChange={setBody}
            placeholder="タスクの期間・進捗・依存関係をタイムラインで一覧できます。"
            rows={4}
            disabled={busy}
          />
        </FormField>
        <FormField label="対象アプリ（任意）" htmlFor="release-app">
          <TextField
            id="release-app"
            value={app}
            onChange={setApp}
            placeholder="ガントチャート"
            disabled={busy}
          />
        </FormField>
        <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
          全員に配信
        </Button>
      </Form>
    </section>
  );
}
