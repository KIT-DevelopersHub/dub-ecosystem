// Account settings (アカウント設定). The signed-in user edits their OWN profile — display
// name + avatar — from the shell chrome (設定 ⚙ → アカウント設定), deliberately separate
// from FE7's admin roster (which manages OTHER users). Password change lives INSIDE this
// dialog too (a パスワード section), so all self-service account actions are unified under
// one entry instead of scattered across the ⚙ menu.
//
// Save is OPTIMISTIC ([[optimistic-ui-principle]]): the /me query cache is patched
// immediately (header avatar + name update at once) and a success toast shows; on failure
// the cache rolls back to the pre-save snapshot and an error toast explains. Posts to the
// gateway-owned POST /api/v1/me/profile (api.auth.updateProfile).
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Button, TextField, FormField, Avatar, useToast } from "@dub/ui";
import type { gateway } from "@dub/types";
import { ApiError, toDisplayableError, type ApiClient } from "../lib/api-client.tsx";
import { queryKeys } from "../lib/queryKeys.tsx";
import { ChangePasswordDialog } from "./ChangePasswordDialog.tsx";

type MeResponse = gateway.MeResponse;

const MAX_NAME_LENGTH = 40;
// Cap an uploaded avatar so the data: URL stays small (demo stores it in localStorage /
// the /me cache). ~512KB pre-encode keeps the base64 well under storage limits.
const MAX_AVATAR_BYTES = 512 * 1024;

// Preset avatars: a small palette of solid-colour tiles rendered as self-contained SVG
// data: URLs (no network). Picking one sets avatarUrl to that data URL — a "preset avatar"
// with no upload. The viewer's initials sit on top so each preset still reads as *them*.
const PRESET_COLORS = ["#2563eb", "#059669", "#d97706", "#db2777", "#7c3aed", "#0891b2"] as const;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2);
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function presetAvatarDataUrl(color: string, name: string): string {
  const label = initialsOf(name);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${color}"/><text x="48" y="48" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="40" font-weight="600" fill="#ffffff">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function AccountSettingsDialog({
  api,
  open,
  onClose,
}: {
  api: ApiClient;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const me = qc.getQueryData<MeResponse>(queryKeys.me);
  const currentName = me?.user.displayName ?? "";
  const currentAvatar = me?.user.avatarUrl ?? null;
  const email = me?.user.email ?? null;

  const [name, setName] = useState(currentName);
  const [avatar, setAvatar] = useState<string | null>(currentAvatar);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Re-sync the draft from the live /me whenever the dialog (re)opens, so it always
  // starts from the persisted values (e.g. after a previous save or account switch).
  useEffect(() => {
    if (open) {
      setName(currentName);
      setAvatar(currentAvatar);
      setError(null);
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmed = name.trim();
  const tooLong = trimmed.length > MAX_NAME_LENGTH;
  const nameEmpty = trimmed.length === 0;
  const dirty = trimmed !== currentName || avatar !== currentAvatar;
  const canSubmit = dirty && !nameEmpty && !tooLong && !submitting;

  function close() {
    if (submitting) return;
    onClose();
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("画像ファイルを選択してください。");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError("画像サイズが大きすぎます（512KB 以下にしてください）。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setError(null);
      setAvatar(typeof reader.result === "string" ? reader.result : null);
    };
    reader.onerror = () => setError("画像の読み込みに失敗しました。");
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const prev = qc.getQueryData<MeResponse>(queryKeys.me);
    // Optimistic: patch the /me cache NOW so the header avatar + name update instantly.
    qc.setQueryData<MeResponse>(queryKeys.me, (old) =>
      old ? { ...old, user: { ...old.user, displayName: trimmed, avatarUrl: avatar } } : old,
    );
    try {
      const updated = await api.auth.updateProfile({ displayName: trimmed, avatarUrl: avatar });
      // Reconcile with the server's canonical values.
      qc.setQueryData<MeResponse>(queryKeys.me, (old) =>
        old ? { ...old, user: { ...old.user, displayName: updated.displayName, avatarUrl: updated.avatarUrl } } : old,
      );
      toast.show({ kind: "success", title: "アカウント設定を保存しました" });
      setSubmitting(false);
      onClose();
    } catch (e) {
      // Roll back the optimistic patch and explain.
      if (prev) qc.setQueryData(queryKeys.me, prev);
      const msg = ApiError.isApiError(e) ? toDisplayableError(e).message : "保存に失敗しました。";
      setError(msg);
      toast.show({ kind: "error", title: "アカウント設定を保存できませんでした", description: msg });
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={close}
        title="アカウント設定"
        testId="fe2-account-settings"
        footer={
          <>
            <Button variant="secondary" onClick={close} testId="fe2-account-settings-cancel">
              キャンセル
            </Button>
            <Button variant="primary" onClick={save} disabled={!canSubmit} loading={submitting} testId="fe2-account-settings-save">
              保存する
            </Button>
          </>
        }
      >
        <div className="fe2-account-form">
          {/* Avatar preview + controls */}
          <div className="fe2-account-avatar-row">
            <Avatar name={trimmed || currentName || "?"} src={avatar ?? undefined} size="lg" testId="fe2-account-avatar-preview" />
            <div className="fe2-account-avatar-controls">
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} testId="fe2-account-avatar-upload">
                画像をアップロード
              </Button>
              <button type="button" className="fe2-account-avatar-clear" onClick={() => setAvatar(null)} disabled={avatar === null} data-testid="fe2-account-avatar-clear">
                イニシャルに戻す
              </button>
              <input ref={fileRef} type="file" accept="image/*" onChange={onPickFile} style={{ display: "none" }} data-testid="fe2-account-avatar-file" />
            </div>
          </div>

          {/* Preset avatars */}
          <div className="fe2-account-presets" role="group" aria-label="プリセットアバター">
            {PRESET_COLORS.map((color) => {
              const url = presetAvatarDataUrl(color, trimmed || currentName || "?");
              const selected = avatar === url;
              return (
                <button
                  key={color}
                  type="button"
                  className="fe2-account-preset"
                  data-selected={selected}
                  aria-pressed={selected}
                  aria-label={`プリセットアバター ${color}`}
                  onClick={() => setAvatar(url)}
                  data-testid={`fe2-account-preset-${color}`}
                >
                  <img src={url} alt="" width={40} height={40} />
                </button>
              );
            })}
          </div>

          {/* Display name */}
          <FormField
            label="表示名"
            htmlFor="fe2-account-name"
            required
            {...(tooLong ? { error: `表示名は${MAX_NAME_LENGTH}文字以内で入力してください。` } : {})}
            help="ヘッダーや名簿・タスクの担当表示に使われます。"
          >
            <TextField id="fe2-account-name" value={name} onChange={setName} invalid={nameEmpty || tooLong} testId="fe2-account-name" />
          </FormField>

          {/* Read-only basic info */}
          <FormField label="メールアドレス" htmlFor="fe2-account-email" help="ログイン中のアカウント（変更不可）">
            <TextField id="fe2-account-email" value={email ?? "—"} onChange={() => {}} disabled testId="fe2-account-email" />
          </FormField>

          {/* Password — kept adjacent/unified under アカウント設定 */}
          <div className="fe2-account-password">
            <div>
              <div className="fe2-account-password-label">パスワード</div>
              <div className="fe2-account-password-help">ログインに使うパスワードを変更します。</div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setPwOpen(true)} testId="fe2-account-password-open">
              パスワードを変更
            </Button>
          </div>

          {error ? (
            <p role="alert" data-testid="fe2-account-settings-error" className="fe2-account-error">
              {error}
            </p>
          ) : null}
        </div>
      </Modal>

      <ChangePasswordDialog api={api} open={pwOpen} onClose={() => setPwOpen(false)} />
    </>
  );
}
