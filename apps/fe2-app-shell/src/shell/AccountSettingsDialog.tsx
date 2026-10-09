// Account settings (アカウント設定). The signed-in user edits their OWN account from the
// shell chrome (設定 ⚙ → アカウント設定), deliberately separate from FE7's admin roster
// (which manages OTHER users). One dialog unifies every self-service action:
//   • プロフィール — display name + avatar (upload / preset / initials)
//   • 基本情報      — login email (read-only) + password change (nested dialog)
//   • ブラウザ通知  — per-device opt-in for OS notifications on chat @mentions (applies
//                     immediately; not part of 保存する since it needs a permission prompt)
//   • 参加情報      — the fields the user entered in the 参加届 (participation form),
//                     rendered by the shared PersonProfileFields (運営名簿・参加届と共通の
//                     PersonProfile) so the set never drifts from the roster / submit contract.
//
// Save is OPTIMISTIC ([[optimistic-ui-principle]]): the /me and 参加届 caches are patched
// immediately (header avatar + name update at once) and a success toast shows; on failure
// both caches roll back to their pre-save snapshots and an error toast explains.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, Button, TextField, FormField, Avatar, Skeleton, Switch, useToast } from "@dub/ui";
import {
  getBrowserNotifyEnabled,
  getBrowserNotifyPermission,
  requestBrowserNotifyPermission,
  setBrowserNotifyEnabled,
  showBrowserNotice,
  type BrowserNotifyPermission,
} from "@dub/fe5-notification-inbox";
import type { gateway } from "@dub/types";
import { ApiError, toDisplayableError, type ApiClient, type SelfParticipation } from "../lib/api-client.tsx";
import { queryKeys } from "../lib/queryKeys.tsx";
import {
  PersonProfileFields,
  emptyProfileDraft,
  parseProfileDraft,
  toProfileDraft,
  type PersonProfileDraft,
  type PersonProfileErrors,
} from "../lib/personProfile.tsx";
import { ChangePasswordDialog } from "./ChangePasswordDialog.tsx";
import { PasskeysDialog } from "./PasskeysDialog.tsx";

type MeResponse = gateway.MeResponse;

const MAX_NAME_LENGTH = 40;
// Cap an uploaded avatar so the data: URL stays small (demo stores it in localStorage /
// the /me cache). ~512KB pre-encode keeps the base64 well under storage limits.
const MAX_AVATAR_BYTES = 512 * 1024;

// The 参加届 profile lives under its own query key (a shell-owned feature key).
const PARTICIPATION_KEY = queryKeys.feature("me-participation");

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

function draftEquals(a: PersonProfileDraft, b: PersonProfileDraft): boolean {
  return (Object.keys(a) as (keyof PersonProfileDraft)[]).every((k) => a[k].trim() === b[k].trim());
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
  const [part, setPart] = useState<PersonProfileDraft>(emptyProfileDraft);
  const [partErrors, setPartErrors] = useState<PersonProfileErrors>({});
  const [submitting, setSubmitting] = useState(false);
  // P12 delight UX: the save button flashes a checkmark in place before the dialog
  // closes, so success reads at the button — the toast stays as a secondary trail,
  // not the only signal.
  const [saveSuccess, setSaveSuccess] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [passkeysOpen, setPasskeysOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const partSeeded = useRef(false);

  // The signed-in user's own 参加届 (loaded when the dialog opens).
  const partQuery = useQuery({
    queryKey: PARTICIPATION_KEY,
    queryFn: () => api.auth.getSelfParticipation(),
    enabled: open,
    staleTime: 60_000,
  });
  const loadedPart = partQuery.data ?? null;

  // Re-sync the profile draft from the live /me whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setName(currentName);
      setAvatar(currentAvatar);
      setError(null);
      setSubmitting(false);
    } else {
      partSeeded.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Seed the 参加届 draft ONCE per open, when its data arrives (so edits aren't clobbered
  // by a background refetch).
  useEffect(() => {
    if (open && !partSeeded.current && loadedPart) {
      setPart(toProfileDraft(loadedPart));
      setPartErrors({});
      partSeeded.current = true;
    }
  }, [open, loadedPart]);

  const trimmed = name.trim();
  const tooLong = trimmed.length > MAX_NAME_LENGTH;
  const nameEmpty = trimmed.length === 0;
  const profileDirty = trimmed !== currentName || avatar !== currentAvatar;
  const participationDirty = loadedPart != null && partSeeded.current && !draftEquals(part, toProfileDraft(loadedPart));
  const dirty = profileDirty || participationDirty;
  const canSubmit = dirty && !nameEmpty && !tooLong && !submitting && !saveSuccess;

  function close() {
    if (submitting || saveSuccess) return;
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
    const { profile: nextPart, errors: partErrs } = parseProfileDraft(part);
    setPartErrors(partErrs);
    if (participationDirty && Object.keys(partErrs).length > 0) return;
    setSubmitting(true);
    setError(null);
    const prevMe = qc.getQueryData<MeResponse>(queryKeys.me);
    const prevPart = qc.getQueryData<SelfParticipation>(PARTICIPATION_KEY);
    // Optimistic: patch BOTH caches NOW so the header + form reflect immediately.
    if (profileDirty) {
      qc.setQueryData<MeResponse>(queryKeys.me, (old) =>
        old ? { ...old, user: { ...old.user, displayName: trimmed, avatarUrl: avatar } } : old,
      );
    }
    if (participationDirty) qc.setQueryData<SelfParticipation>(PARTICIPATION_KEY, nextPart);
    try {
      const ops: Promise<unknown>[] = [];
      if (profileDirty) {
        ops.push(
          api.auth.updateProfile({ displayName: trimmed, avatarUrl: avatar }).then((updated) =>
            qc.setQueryData<MeResponse>(queryKeys.me, (old) =>
              old ? { ...old, user: { ...old.user, displayName: updated.displayName, avatarUrl: updated.avatarUrl } } : old,
            ),
          ),
        );
      }
      if (participationDirty) {
        ops.push(api.auth.updateSelfParticipation(nextPart).then((res) => qc.setQueryData(PARTICIPATION_KEY, res)));
      }
      await Promise.all(ops);
      toast.show({ kind: "success", title: "アカウント設定を保存しました" });
      setSubmitting(false);
      // Show the button's own success flash before closing (P12) — a beat long
      // enough to register, short enough not to feel like a stall.
      setSaveSuccess(true);
      closeTimer.current = setTimeout(() => {
        setSaveSuccess(false);
        onClose();
      }, 650);
    } catch (e) {
      // Roll back BOTH optimistic patches and explain.
      if (prevMe) qc.setQueryData(queryKeys.me, prevMe);
      if (prevPart) qc.setQueryData(PARTICIPATION_KEY, prevPart);
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
            <Button
              variant="primary"
              onClick={save}
              disabled={!canSubmit}
              loading={submitting}
              success={saveSuccess}
              testId="fe2-account-settings-save"
            >
              保存する
            </Button>
          </>
        }
      >
        <div className="fe2-account-form">
          {/* ── プロフィール ── */}
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

          <FormField
            label="表示名"
            htmlFor="fe2-account-name"
            required
            {...(tooLong ? { error: `表示名は${MAX_NAME_LENGTH}文字以内で入力してください。` } : {})}
            help="ヘッダーや名簿・タスクの担当表示に使われます。"
          >
            <TextField id="fe2-account-name" value={name} onChange={setName} invalid={nameEmpty || tooLong} testId="fe2-account-name" />
          </FormField>

          {/* ── 基本情報 ── */}
          <FormField label="メールアドレス" htmlFor="fe2-account-email" help="ログイン中のアカウント（変更不可）">
            <TextField id="fe2-account-email" value={email ?? "—"} onChange={() => {}} disabled testId="fe2-account-email" />
          </FormField>

          <div className="fe2-account-password">
            <div>
              <div className="fe2-account-password-label">パスワード</div>
              <div className="fe2-account-password-help">ログインに使うパスワードを変更します。</div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setPwOpen(true)} testId="fe2-account-password-open">
              パスワードを変更
            </Button>
          </div>

          <div className="fe2-account-password">
            <div>
              <div className="fe2-account-password-label">パスキー</div>
              <div className="fe2-account-password-help">指紋・顔認証・端末の PIN でログインできるようにします。</div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setPasskeysOpen(true)} testId="fe2-account-passkeys-open">
              パスキーを管理
            </Button>
          </div>

          <BrowserNotifySetting open={open} />

          {/* ── 参加情報（参加届） ── */}
          <div className="fe2-account-section" data-testid="fe2-account-participation">
            <div className="fe2-account-section-title">参加情報（参加届）</div>
            <div className="fe2-account-section-help">イベント参加登録フォームで入力した項目を編集できます。</div>
            {partQuery.isPending ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--dub-space-3)" }}>
                <Skeleton width="100%" height={40} />
                <Skeleton width="100%" height={40} />
                <Skeleton width="100%" height={40} />
              </div>
            ) : partQuery.isError ? (
              <p role="alert" className="fe2-account-error" data-testid="fe2-account-participation-error">
                参加情報を読み込めませんでした。
              </p>
            ) : (
              <PersonProfileFields
                draft={part}
                onChange={setPart}
                errors={partErrors}
                idPrefix="fe2-part"
                idFor={(k) => `fe2-part-${k}`}
              />
            )}
          </div>

          {error ? (
            <p role="alert" data-testid="fe2-account-settings-error" className="fe2-account-error">
              {error}
            </p>
          ) : null}
        </div>
      </Modal>

      <ChangePasswordDialog api={api} open={pwOpen} onClose={() => setPwOpen(false)} />
      <PasskeysDialog api={api} open={passkeysOpen} onClose={() => setPasskeysOpen(false)} />
    </>
  );
}

function browserNotifyHelp(perm: BrowserNotifyPermission): string {
  switch (perm) {
    case "unsupported":
      return "このブラウザは通知に対応していません。";
    case "denied":
      return "ブラウザで通知がブロックされています。アドレスバーのサイト設定から通知を許可してください。";
    default:
      return "チャットで自分宛てのメンションが届いたとき、PC の通知でお知らせします（この端末のこのブラウザで、アプリを開いている間）。";
  }
}

/** ブラウザ通知 row — device-local, so it saves the moment it is toggled. */
function BrowserNotifySetting({ open }: { open: boolean }): JSX.Element {
  const [perm, setPerm] = useState<BrowserNotifyPermission>(getBrowserNotifyPermission);
  const [enabled, setEnabled] = useState(getBrowserNotifyEnabled);
  const [busy, setBusy] = useState(false);

  // Permission can change in the browser's site settings while the dialog is closed.
  useEffect(() => {
    if (open) {
      setPerm(getBrowserNotifyPermission());
      setEnabled(getBrowserNotifyEnabled());
    }
  }, [open]);

  async function onToggle(next: boolean) {
    if (!next) {
      setBrowserNotifyEnabled(false);
      setEnabled(false);
      return;
    }
    setBusy(true);
    const result = await requestBrowserNotifyPermission();
    setPerm(result);
    setBusy(false);
    if (result !== "granted") return;
    setBrowserNotifyEnabled(true);
    setEnabled(true);
    showBrowserNotice({
      title: "ブラウザ通知を有効にしました",
      body: "自分宛てのメンションが届くと、このように通知されます。",
      tag: "dub-notif-enabled",
    });
  }

  return (
    <div className="fe2-account-notify" data-testid="fe2-account-browser-notify">
      <Switch
        id="fe2-account-browser-notify"
        checked={enabled && perm === "granted"}
        onChange={(v) => void onToggle(v)}
        disabled={busy || perm === "unsupported" || perm === "denied"}
        label="ブラウザの通知を有効にする"
        testId="fe2-account-browser-notify-toggle"
      />
      <div className="fe2-account-password-help" data-testid="fe2-account-browser-notify-help">
        {browserNotifyHelp(perm)}
      </div>
    </div>
  );
}
