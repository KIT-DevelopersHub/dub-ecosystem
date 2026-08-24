// Account settings (アカウント設定). The signed-in user edits their OWN account from the
// shell chrome (設定 ⚙ → アカウント設定), deliberately separate from FE7's admin roster
// (which manages OTHER users). One dialog unifies every self-service action:
//   • プロフィール — display name + avatar (upload / preset / initials)
//   • 基本情報      — login email (read-only) + password change (nested dialog)
//   • 参加情報      — the fields the user entered in the 参加届 (participation form),
//                     rendered from the SINGLE-SOURCE descriptor (profileFields.ts) so the
//                     set never drifts from the submit contract.
//
// Save is OPTIMISTIC ([[optimistic-ui-principle]]): the /me and 参加届 caches are patched
// immediately (header avatar + name update at once) and a success toast shows; on failure
// both caches roll back to their pre-save snapshots and an error toast explains.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, Button, TextField, Textarea, Select, FormField, Avatar, Skeleton, useToast } from "@dub/ui";
import type { gateway } from "@dub/types";
import { ApiError, toDisplayableError, type ApiClient, type SelfParticipation } from "../lib/api-client.tsx";
import { queryKeys } from "../lib/queryKeys.tsx";
import { PARTICIPATION_PROFILE_FIELDS, emptySelfParticipation, type ParticipationFieldDescriptor } from "../features/participation/index.tsx";
import { ChangePasswordDialog } from "./ChangePasswordDialog.tsx";

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

// ── 参加届 draft helpers (Record<key,string>; "" == null) ──────────────────────
type PartDraft = Record<string, string>;
function toDraft(p: SelfParticipation): PartDraft {
  const d: PartDraft = {};
  for (const f of PARTICIPATION_PROFILE_FIELDS) {
    const v = p[f.key];
    d[f.key] = v == null ? "" : String(v);
  }
  return d;
}
function draftToPatch(d: PartDraft): SelfParticipation {
  const out = emptySelfParticipation();
  for (const f of PARTICIPATION_PROFILE_FIELDS) {
    const v = (d[f.key] ?? "").trim();
    // Values come from constrained controls (selects use the closed unions), so the
    // string→union cast is runtime-safe; empty clears the field.
    (out as unknown as Record<string, unknown>)[f.key] = v.length > 0 ? v : null;
  }
  return out;
}
function draftEquals(a: PartDraft, b: PartDraft): boolean {
  return PARTICIPATION_PROFILE_FIELDS.every((f) => (a[f.key] ?? "").trim() === (b[f.key] ?? "").trim());
}

// Group the descriptor into rows: consecutive `half` fields pair up (2-up); full-width
// fields (textarea) stand alone.
function toRows(fields: ParticipationFieldDescriptor[]): ParticipationFieldDescriptor[][] {
  const rows: ParticipationFieldDescriptor[][] = [];
  let buf: ParticipationFieldDescriptor[] = [];
  for (const f of fields) {
    if (f.half) {
      buf.push(f);
      if (buf.length === 2) {
        rows.push(buf);
        buf = [];
      }
    } else {
      if (buf.length) {
        rows.push(buf);
        buf = [];
      }
      rows.push([f]);
    }
  }
  if (buf.length) rows.push(buf);
  return rows;
}
const PARTICIPATION_ROWS = toRows(PARTICIPATION_PROFILE_FIELDS);

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
  const [part, setPart] = useState<PartDraft>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
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
      setPart(toDraft(loadedPart));
      partSeeded.current = true;
    }
  }, [open, loadedPart]);

  const trimmed = name.trim();
  const tooLong = trimmed.length > MAX_NAME_LENGTH;
  const nameEmpty = trimmed.length === 0;
  const profileDirty = trimmed !== currentName || avatar !== currentAvatar;
  const participationDirty = loadedPart != null && partSeeded.current && !draftEquals(part, toDraft(loadedPart));
  const dirty = profileDirty || participationDirty;
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
    const prevMe = qc.getQueryData<MeResponse>(queryKeys.me);
    const prevPart = qc.getQueryData<SelfParticipation>(PARTICIPATION_KEY);
    const nextPart = draftToPatch(part);
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
      onClose();
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

  function renderControl(f: ParticipationFieldDescriptor): JSX.Element {
    const id = `fe2-part-${f.key}`;
    const val = part[f.key] ?? "";
    const set = (v: string) => setPart((prev) => ({ ...prev, [f.key]: v }));
    if (f.kind === "select") {
      return <Select id={id} value={val.length > 0 ? val : null} onChange={set} options={f.options ?? []} placeholder="選択してください" testId={id} />;
    }
    if (f.kind === "textarea") {
      return <Textarea id={id} value={val} onChange={set} rows={3} testId={id} />;
    }
    return <TextField id={id} type={f.kind === "email" ? "email" : "text"} value={val} onChange={set} {...(f.placeholder ? { placeholder: f.placeholder } : {})} testId={id} />;
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
              PARTICIPATION_ROWS.map((row, i) => (
                <div key={i} className={row.length > 1 ? "fe2-account-prow" : undefined}>
                  {row.map((f) => (
                    <FormField key={f.key} label={f.label} htmlFor={`fe2-part-${f.key}`} {...(f.help ? { help: f.help } : {})}>
                      {renderControl(f)}
                    </FormField>
                  ))}
                </div>
              ))
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
    </>
  );
}
