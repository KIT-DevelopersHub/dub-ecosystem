// Passkey management (アカウント設定 → パスキー). Lists the signed-in user's own passkeys
// and lets them add / rename / delete. Adding requires re-entering the current password
// (server-side step-up) so a hijacked session cannot plant an attacker's authenticator.
// Rename + delete are OPTIMISTIC ([[optimistic-ui-principle]]): the list updates at once
// and rolls back with an error toast if the server refuses (e.g. last sign-in method).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, Button, TextField, FormField, Skeleton, ConfirmDialog, useToast } from "@dub/ui";
import { ApiError, toDisplayableError, type ApiClient, type PasskeySummary } from "../lib/api-client.tsx";
import { queryKeys } from "../lib/queryKeys.tsx";
import { defaultPasskeyLabel, passkeysSupported, registerPasskey } from "../lib/passkey.tsx";

const PASSKEYS_KEY = queryKeys.feature("me-passkeys");
const MAX_LABEL = 64;

function formatDate(iso: string | null): string {
  if (!iso) return "未使用";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function errorText(e: unknown, fallback: string): string {
  return ApiError.isApiError(e) ? toDisplayableError(e).message : fallback;
}

export function PasskeysDialog({ api, open, onClose }: { api: ApiClient; open: boolean; onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const supported = passkeysSupported();
  const list = useQuery({ queryKey: PASSKEYS_KEY, queryFn: () => api.auth.passkeys.list(), enabled: open });

  const [adding, setAdding] = useState(false);
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState<PasskeySummary | null>(null);

  const items = list.data?.items ?? [];
  const setItems = (fn: (prev: PasskeySummary[]) => PasskeySummary[]) =>
    qc.setQueryData<{ items: PasskeySummary[] }>(PASSKEYS_KEY, (old) => ({ items: fn(old?.items ?? []) }));

  function startAdd() {
    setAdding(true);
    setPassword("");
    setLabel(defaultPasskeyLabel());
    setAddError(null);
  }

  async function submitAdd() {
    if (submitting || !password) return;
    setSubmitting(true);
    setAddError(null);
    const out = await registerPasskey(api, password, label.trim() || defaultPasskeyLabel());
    setSubmitting(false);
    if (out.ok) {
      setItems((prev) => [...prev, out.passkey]);
      setAdding(false);
      setPassword("");
      toast.show({ kind: "success", title: "パスキーを登録しました", description: "次回からパスキーでログインできます。" });
      return;
    }
    setAddError(out.kind === "cancelled" ? "登録がキャンセルされました。もう一度お試しください。" : out.message);
  }

  // Row-level rollback: a failure restores ONLY the row it touched, so two overlapping
  // mutations cannot resurrect each other. In-flight refetches are cancelled before the
  // optimistic write and the list is re-synced with the server afterwards.
  async function saveRename() {
    if (!editing) return;
    const { id } = editing;
    const next = editing.label.trim().slice(0, MAX_LABEL);
    const before = items.find((p) => p.id === id)?.label;
    setEditing(null);
    if (!next || before === undefined || before === next) return;
    await qc.cancelQueries({ queryKey: PASSKEYS_KEY });
    setItems((cur) => cur.map((p) => (p.id === id ? { ...p, label: next } : p)));
    try {
      await api.auth.passkeys.rename(id, next);
    } catch (e) {
      setItems((cur) => cur.map((p) => (p.id === id && p.label === next ? { ...p, label: before } : p)));
      toast.show({ kind: "error", title: "名前を変更できませんでした", description: errorText(e, "時間をおいて再度お試しください。") });
    } finally {
      void qc.invalidateQueries({ queryKey: PASSKEYS_KEY });
    }
  }

  async function confirmDelete() {
    const target = deleting;
    if (!target) return;
    const index = items.findIndex((p) => p.id === target.id);
    setDeleting(null);
    await qc.cancelQueries({ queryKey: PASSKEYS_KEY });
    setItems((cur) => cur.filter((p) => p.id !== target.id));
    try {
      await api.auth.passkeys.remove(target.id);
      toast.show({ kind: "success", title: "パスキーを削除しました" });
    } catch (e) {
      setItems((cur) => {
        if (cur.some((p) => p.id === target.id)) return cur;
        const out = [...cur];
        out.splice(Math.max(0, Math.min(index, out.length)), 0, target);
        return out;
      });
      toast.show({ kind: "error", title: "パスキーを削除できませんでした", description: errorText(e, "時間をおいて再度お試しください。") });
    } finally {
      void qc.invalidateQueries({ queryKey: PASSKEYS_KEY });
    }
  }

  function close() {
    setAdding(false);
    setPassword("");
    setAddError(null);
    setEditing(null);
    onClose();
  }

  return (
    <>
      <Modal
        open={open}
        onClose={close}
        title="パスキー"
        testId="fe2-passkeys"
        footer={
          <Button variant="secondary" onClick={close} testId="fe2-passkeys-close">
            閉じる
          </Button>
        }
      >
        <div className="fe2-passkeys">
          <p className="fe2-passkeys-intro">
            パスキーを登録すると、次回から指紋・顔認証・端末の PIN だけでログインできます。パスワードは引き続き使えます。
          </p>

          {list.isPending ? (
            <div className="fe2-passkeys-list" data-testid="fe2-passkeys-loading" role="status" aria-busy="true" aria-label="パスキーを読み込み中">
              <Skeleton width="100%" height={56} />
              <Skeleton width="100%" height={56} />
            </div>
          ) : list.isError ? (
            <p role="alert" className="fe2-account-error" data-testid="fe2-passkeys-error">
              パスキーの一覧を読み込めませんでした。
            </p>
          ) : items.length === 0 ? (
            <p className="fe2-passkeys-empty" data-testid="fe2-passkeys-empty">
              まだパスキーが登録されていません。
            </p>
          ) : (
            <ul className="fe2-passkeys-list" data-testid="fe2-passkeys-list">
              {items.map((p) => (
                <li key={p.id} className="fe2-passkeys-item" data-testid="fe2-passkeys-item">
                  {editing?.id === p.id ? (
                    <form
                      className="fe2-passkeys-rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveRename();
                      }}
                    >
                      <FormField label="名前" htmlFor={`fe2-passkey-label-${p.id}`}>
                        <TextField
                          id={`fe2-passkey-label-${p.id}`}
                          value={editing.label}
                          onChange={(v) => setEditing({ id: p.id, label: v.slice(0, MAX_LABEL) })}
                          testId="fe2-passkeys-rename-input"
                        />
                      </FormField>
                      <Button type="submit" size="sm" testId="fe2-passkeys-rename-save">
                        保存
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                        キャンセル
                      </Button>
                    </form>
                  ) : (
                    <>
                      <div className="fe2-passkeys-meta">
                        <div className="fe2-passkeys-label">{p.label}</div>
                        <div className="fe2-passkeys-sub">
                          追加 {formatDate(p.createdAt)} ・ 最終使用 {formatDate(p.lastUsedAt)}
                          {p.backedUp ? " ・ 同期済み" : ""}
                        </div>
                      </div>
                      <div className="fe2-passkeys-actions">
                        <Button variant="ghost" size="sm" onClick={() => setEditing({ id: p.id, label: p.label })} testId="fe2-passkeys-rename">
                          名前を変更
                        </Button>
                        <Button variant="ghost" size="sm" className="fe2-passkeys-danger" onClick={() => setDeleting(p)} testId="fe2-passkeys-delete">
                          削除
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!supported ? (
            <p className="fe2-passkeys-empty" data-testid="fe2-passkeys-unsupported">
              このブラウザはパスキーに対応していません。
            </p>
          ) : adding ? (
            <form
              className="fe2-passkeys-add"
              data-testid="fe2-passkeys-add-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitAdd();
              }}
            >
              <FormField label="現在のパスワード" htmlFor="fe2-passkey-password" help="本人確認のため、パスワードを再入力してください。">
                <TextField id="fe2-passkey-password" type="password" value={password} onChange={setPassword} disabled={submitting} testId="fe2-passkeys-password" />
              </FormField>
              <FormField label="名前" htmlFor="fe2-passkey-new-label" help="どの端末のパスキーか分かる名前を付けます。">
                <TextField id="fe2-passkey-new-label" value={label} onChange={(v) => setLabel(v.slice(0, MAX_LABEL))} disabled={submitting} testId="fe2-passkeys-label" />
              </FormField>
              {addError ? (
                <p role="alert" className="fe2-account-error" data-testid="fe2-passkeys-add-error">
                  {addError}
                </p>
              ) : null}
              <div className="fe2-passkeys-add-actions">
                <Button variant="ghost" onClick={() => setAdding(false)} disabled={submitting}>
                  キャンセル
                </Button>
                <Button type="submit" loading={submitting} disabled={!password} testId="fe2-passkeys-add-submit">
                  登録する
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" onClick={startAdd} disabled={list.isPending} testId="fe2-passkeys-add">
              パスキーを追加
            </Button>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="パスキーを削除"
        message={`「${deleting?.label ?? ""}」を削除します。このパスキーではログインできなくなります（端末に保存されたパスキー自体は端末の設定から削除できます）。`}
        confirmLabel="削除する"
        danger
        onConfirm={() => {
          void confirmDelete();
        }}
        onCancel={() => setDeleting(null)}
        testId="fe2-passkeys-delete-confirm"
      />
    </>
  );
}
