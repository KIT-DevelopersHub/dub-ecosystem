// 定型文 (#867): the compose window's template button + dialog. Pick a template to insert its
// subject and body, save the current compose as a new one, or edit / delete saved ones.
// Saves and deletes are OPTIMISTIC ([[optimistic-ui-principle]]): the list changes at once and
// rolls back with an inline error when the server refuses. Templates are personal (per account).
import { useCallback, useEffect, useState } from "react";
import { Button, ConfirmDialog, EmptyState, FormField, Modal, SkeletonLoader, TextField, Textarea } from "@dub/ui";
import { mail } from "@dub/types";
import { useCanCompose, useMailApi } from "../MailProvider.tsx";
import { MailIcon } from "./icons.tsx";
import { uid } from "./useMailStore.tsx";
import styles from "./TemplatePicker.module.css";

type Template = mail.MailTemplate;
type Draft = { id: string | null; title: string; subject: string; body: string };

/** What inserting a template does to the compose: a template subject replaces the subject; its
 *  body goes above what is already typed (a reply's quote stays below). */
export function applyTemplate(compose: { subject: string; body: string }, t: mail.MailTemplateInput): { subject: string; body: string } {
  const subject = t.subject.trim() ? t.subject : compose.subject;
  const body = compose.body.trim() ? `${t.body}\n\n${compose.body}` : t.body;
  return { subject, body };
}

function useTemplates(open: boolean) {
  const api = useMailApi();
  const [items, setItems] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    api.listTemplates().then(
      (list) => alive && setItems(list),
      () => {
        if (!alive) return;
        setItems((prev) => prev ?? []);
        setError("定型文を読み込めませんでした。");
      },
    );
    return () => {
      alive = false;
    };
  }, [api, open]);

  const save = useCallback(
    async (d: Draft): Promise<void> => {
      const id = d.id ?? uid("tpl");
      const input: mail.MailTemplateInput = { title: d.title.trim(), subject: d.subject, body: d.body };
      const prev = items;
      const optimistic: Template = { ...input, id, updatedAt: new Date().toISOString() };
      setItems([optimistic, ...(prev ?? []).filter((t) => t.id !== id)]);
      setError(null);
      try {
        const saved = await api.saveTemplate(id, input);
        setItems((cur) => (cur ?? []).map((t) => (t.id === id ? saved : t)));
      } catch {
        setItems(prev);
        setError("定型文を保存できませんでした。");
      }
    },
    [api, items],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      const prev = items;
      setItems((prev ?? []).filter((t) => t.id !== id));
      setError(null);
      try {
        await api.deleteTemplate(id);
      } catch {
        setItems(prev);
        setError("定型文を削除できませんでした。");
      }
    },
    [api, items],
  );

  return { items, error, save, remove };
}

export function TemplatePicker({
  compose,
  onInsert,
  disabled,
}: {
  compose: { subject: string; body: string };
  onInsert: (next: { subject: string; body: string }) => void;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Template | null>(null);
  const canCompose = useCanCompose();
  const tpl = useTemplates(open);

  const close = (): void => {
    setOpen(false);
    setDraft(null);
  };
  const titleMissing = draft !== null && draft.title.trim() === "";

  return (
    <>
      <button
        type="button"
        aria-label="定型文"
        title="定型文"
        data-testid="fe2-mail-compose-templates"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={styles.trigger}
      >
        <MailIcon name="file" size={18} />
      </button>
      <Modal
        open={open}
        onClose={close}
        title={draft ? (draft.id ? "定型文を編集" : "定型文を保存") : "定型文"}
        size="md"
        testId="fe2-mail-templates-dialog"
        footer={
          draft ? (
            <>
              <Button variant="secondary" onClick={() => setDraft(null)} testId="fe2-mail-template-cancel">
                戻る
              </Button>
              <Button
                variant="primary"
                disabled={titleMissing}
                onClick={() => {
                  void tpl.save(draft);
                  setDraft(null);
                }}
                testId="fe2-mail-template-save"
              >
                保存
              </Button>
            </>
          ) : canCompose ? (
            <>
              <Button variant="secondary" onClick={() => setDraft({ id: null, title: "", subject: "", body: "" })} testId="fe2-mail-template-new">
                新しい定型文
              </Button>
              <Button
                variant="secondary"
                disabled={!compose.subject.trim() && !compose.body.trim()}
                onClick={() => setDraft({ id: null, title: compose.subject.trim(), subject: compose.subject, body: compose.body })}
                testId="fe2-mail-template-save-current"
              >
                今の内容を保存
              </Button>
            </>
          ) : null
        }
      >
        {tpl.error ? (
          <p role="alert" className={styles.error} data-testid="fe2-mail-templates-error">
            {tpl.error}
          </p>
        ) : null}
        {draft ? (
          <div className={styles.form}>
            <FormField label="名前" htmlFor="fe2-mail-template-title" required {...(titleMissing ? { error: "名前を入力してください" } : {})}>
              <TextField
                id="fe2-mail-template-title"
                value={draft.title}
                onChange={(v) => setDraft({ ...draft, title: v.slice(0, mail.MAIL_TEMPLATE_TITLE_MAX) })}
                placeholder="例: 加入面談のご案内"
                invalid={titleMissing}
                testId="fe2-mail-template-title"
              />
            </FormField>
            <FormField label="件名" htmlFor="fe2-mail-template-subject" help="空のときは件名を変えずに本文だけ入れます">
              <TextField id="fe2-mail-template-subject" value={draft.subject} onChange={(v) => setDraft({ ...draft, subject: v })} testId="fe2-mail-template-subject" />
            </FormField>
            <FormField label="本文" htmlFor="fe2-mail-template-body">
              <Textarea
                id="fe2-mail-template-body"
                value={draft.body}
                onChange={(v) => setDraft({ ...draft, body: v.slice(0, mail.MAIL_TEMPLATE_BODY_MAX) })}
                rows={8}
                testId="fe2-mail-template-body"
              />
            </FormField>
          </div>
        ) : tpl.items === null ? (
          <SkeletonLoader lines={4} testId="fe2-mail-templates-skeleton" />
        ) : tpl.items.length === 0 ? (
          <EmptyState title="定型文はまだありません" description="よく送る件名と本文を保存しておくと、作成画面からすぐに呼び出せます。" testId="fe2-mail-templates-empty" />
        ) : (
          <ul className={styles.list} data-testid="fe2-mail-templates-list">
            {tpl.items.map((t) => (
              <li key={t.id} className={styles.row} data-testid="fe2-mail-template-row">
                <button
                  type="button"
                  className={styles.pick}
                  onClick={() => {
                    onInsert(applyTemplate(compose, t));
                    close();
                  }}
                  data-testid={`fe2-mail-template-insert-${t.id}`}
                >
                  <span className={styles.title}>{t.title}</span>
                  <span className={styles.preview}>{t.subject || t.body.split("\n")[0] || "（本文なし）"}</span>
                </button>
                {canCompose ? (
                  <span className={styles.actions}>
                    <Button variant="ghost" size="sm" onClick={() => setDraft({ id: t.id, title: t.title, subject: t.subject, body: t.body })} testId={`fe2-mail-template-edit-${t.id}`}>
                      編集
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(t)} testId={`fe2-mail-template-delete-${t.id}`}>
                      削除
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Modal>
      <ConfirmDialog
        open={confirmDelete !== null}
        title="定型文を削除"
        message={`「${confirmDelete?.title ?? ""}」を削除しますか？`}
        confirmLabel="削除"
        danger
        onConfirm={() => {
          if (confirmDelete) void tpl.remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
        testId="fe2-mail-template-delete-confirm"
      />
    </>
  );
}
