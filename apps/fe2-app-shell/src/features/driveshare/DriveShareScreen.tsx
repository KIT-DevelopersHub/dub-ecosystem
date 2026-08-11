// Hackit Drive sharing manager (drive:read / drive:write). Master→detail:
//   • left: the shared Drive's files/folders (search-filtered), each row showing
//     owner, updated time, and a link-share badge;
//   • right: the selected file's sharing entries — grant by email, change a role,
//     revoke (confirmed), and a link-sharing switch.
// Role changes are optimistic (createOptimisticMutation); revoke is destructive so it
// is non-optimistic behind ConfirmDialog ([[optimistic-ui-principle]]).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  Select,
  SkeletonLoader,
  Stack,
  Switch,
  TextField,
  useToast,
} from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { createOptimisticMutation } from "../../lib/optimistic.tsx";
import { useDriveShareApi } from "./DriveShareProvider.tsx";
import {
  isValidEmail,
  roleLabel,
  type AssignableRole,
  type DriveFile,
  type ListPermissionsResult,
  type ShareRole,
  type SharePermission,
} from "./driveShareApi.tsx";

const ASSIGNABLE_OPTIONS: { value: AssignableRole; label: string }[] = [
  { value: "reader", label: "閲覧者" },
  { value: "commenter", label: "コメント可" },
  { value: "writer", label: "編集者" },
];

function formatUpdated(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

function FileRow({ file, active, onSelect }: { file: DriveFile; active: boolean; onSelect: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-testid="fe2-driveshare-file"
      onClick={onSelect}
      aria-pressed={active}
      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}
      aria-label={`${file.name}${file.isFolder ? "（フォルダ）" : ""}`}
    >
      <Card>
        <Stack gap={1}>
          <Stack direction="row" gap={2} align="center">
            <Icon name={file.isFolder ? "list" : "file"} />
            <strong style={{ fontWeight: active ? 700 : 500 }}>{file.name}</strong>
            {file.linkShared ? (
              <Badge tone="info" testId="fe2-driveshare-linkbadge">
                リンク共有中
              </Badge>
            ) : null}
          </Stack>
          <small>
            {file.ownerName ? `オーナー: ${file.ownerName}` : ""}
            {file.modifiedTime ? ` ・ 更新 ${formatUpdated(file.modifiedTime)}` : ""}
          </small>
        </Stack>
      </Card>
    </button>
  );
}

function PermissionRow({
  fileId,
  permission,
  permsKey,
}: {
  fileId: string;
  permission: SharePermission;
  permsKey: readonly unknown[];
}): JSX.Element {
  const driveApi = useDriveShareApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const isOwner = permission.role === "owner";
  const grantee = permission.type === "anyone" ? "リンクを知っている全員" : permission.emailAddress ?? permission.displayName ?? "(不明)";

  // Optimistic role change: patch the cached permissions list immediately.
  const changeRole = useMutation(
    createOptimisticMutation<{ permission: SharePermission }, AssignableRole, ListPermissionsResult>(queryClient, {
      mutationFn: (role) => driveApi.updateRole(fileId, permission.id, role),
      cacheKey: permsKey,
      applyOptimistic: (prev, role) => ({
        ...prev,
        permissions: prev.permissions.map((p) => (p.id === permission.id ? { ...p, role } : p)),
      }),
      onErrorToast: (err) => toast.show({ kind: "error", title: "ロールを変更できませんでした", description: err.message }),
    }),
  );

  const revoke = useMutation({
    mutationFn: () => driveApi.revoke(fileId, permission.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: "権限を剥奪しました" });
      void queryClient.invalidateQueries({ queryKey: permsKey });
    },
    onError: (err) =>
      toast.show({
        kind: "error",
        title: "剥奪できませんでした",
        description: ApiError.isApiError(err) ? err.message : undefined,
      }),
  });

  return (
    <Card testId="fe2-driveshare-permission">
      <Stack direction="row" gap={2} align="center" justify="between">
        <Stack gap={1}>
          <strong>{grantee}</strong>
          {permission.displayName && permission.type !== "anyone" ? <small>{permission.displayName}</small> : null}
        </Stack>
        <Stack direction="row" gap={2} align="center">
          {isOwner ? (
            <Badge tone="neutral">{roleLabel(permission.role)}</Badge>
          ) : (
            <>
              <Select<AssignableRole>
                id={`fe2-driveshare-role-${permission.id}`}
                testId="fe2-driveshare-role-select"
                value={permission.role as AssignableRole}
                options={ASSIGNABLE_OPTIONS}
                disabled={changeRole.isPending}
                onChange={(role) => changeRole.mutate(role)}
              />
              <Button
                variant="danger"
                testId="fe2-driveshare-revoke"
                loading={revoke.isPending}
                onClick={() => setConfirmRevoke(true)}
              >
                剥奪
              </Button>
            </>
          )}
        </Stack>
      </Stack>
      <ConfirmDialog
        open={confirmRevoke}
        testId="fe2-driveshare-revoke-confirm"
        title="共有を剥奪しますか？"
        message={`${grantee} の「${roleLabel(permission.role)}」権限を剥奪します。`}
        confirmLabel="剥奪する"
        danger
        onConfirm={() => {
          setConfirmRevoke(false);
          revoke.mutate();
        }}
        onCancel={() => setConfirmRevoke(false)}
      />
    </Card>
  );
}

function GrantForm({ fileId, permsKey }: { fileId: string; permsKey: readonly unknown[] }): JSX.Element {
  const driveApi = useDriveShareApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("reader");

  const grant = useMutation({
    mutationFn: () => driveApi.grant(fileId, { emailAddress: email.trim(), role }),
    onSuccess: () => {
      toast.show({ kind: "success", title: "共有しました", description: `${email.trim()} を${roleLabel(role)}として追加` });
      setEmail("");
      setRole("reader");
      void queryClient.invalidateQueries({ queryKey: permsKey });
    },
    onError: (err) =>
      toast.show({
        kind: "error",
        title: "共有できませんでした",
        description: ApiError.isApiError(err) ? err.message : undefined,
      }),
  });

  const emailValid = email.trim().length === 0 || isValidEmail(email);
  const canSubmit = isValidEmail(email) && !grant.isPending;

  return (
    <Card testId="fe2-driveshare-grant">
      <Stack gap={2}>
        <strong>メールで共有を追加</strong>
        <Stack direction="row" gap={2} align="center">
          <TextField
            id="fe2-driveshare-grant-email"
            testId="fe2-driveshare-grant-email"
            type="email"
            placeholder="user@example.com"
            value={email}
            invalid={!emailValid}
            onChange={setEmail}
          />
          <Select<AssignableRole>
            id="fe2-driveshare-grant-role"
            testId="fe2-driveshare-grant-role"
            value={role}
            options={ASSIGNABLE_OPTIONS}
            onChange={setRole}
          />
          <Button testId="fe2-driveshare-grant-submit" disabled={!canSubmit} loading={grant.isPending} onClick={() => grant.mutate()}>
            共有
          </Button>
        </Stack>
        {!emailValid ? <small style={{ color: "var(--dub-color-danger-fg, #b00)" }}>メールアドレスの形式が正しくありません</small> : null}
      </Stack>
    </Card>
  );
}

function LinkSharingToggle({
  file,
  permsKey,
  linkShared,
}: {
  file: DriveFile;
  permsKey: readonly unknown[];
  linkShared: boolean;
}): JSX.Element {
  const driveApi = useDriveShareApi();
  const queryClient = useQueryClient();
  const toast = useToast();

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => driveApi.setLinkSharing(file.id, { enabled, role: "reader" }),
    onSuccess: (result, enabled) => {
      queryClient.setQueryData<ListPermissionsResult>(permsKey, result);
      // the files list carries a linkShared hint — refresh it too
      void queryClient.invalidateQueries({ queryKey: queryKeys.feature("driveshare", "files") });
      toast.show({ kind: "success", title: enabled ? "リンク共有をオンにしました" : "リンク共有をオフにしました" });
    },
    onError: (err) =>
      toast.show({
        kind: "error",
        title: "リンク共有を変更できませんでした",
        description: ApiError.isApiError(err) ? err.message : undefined,
      }),
  });

  return (
    <Card testId="fe2-driveshare-link">
      <Stack direction="row" gap={2} align="center" justify="between">
        <Stack gap={1}>
          <strong>リンクを知っている全員</strong>
          <small>{linkShared ? "オン（閲覧者としてリンク共有中）" : "オフ"}</small>
        </Stack>
        <Switch
          id={`fe2-driveshare-link-${file.id}`}
          testId="fe2-driveshare-link-switch"
          checked={linkShared}
          disabled={toggle.isPending}
          label="リンク共有"
          onChange={(enabled) => toggle.mutate(enabled)}
        />
      </Stack>
    </Card>
  );
}

function PermissionsPanel({ file }: { file: DriveFile }): JSX.Element {
  const driveApi = useDriveShareApi();
  const permsKey = queryKeys.feature("driveshare", "permissions", file.id);
  const query = useQuery({
    queryKey: permsKey,
    queryFn: () => driveApi.listPermissions(file.id),
  });

  let body: JSX.Element;
  if (query.isPending) {
    body = <SkeletonLoader lines={4} />;
  } else if (query.isError) {
    const display = ApiError.isApiError(query.error)
      ? toDisplayableError(query.error)
      : { code: "INTERNAL", message: "権限を読み込めませんでした。" };
    body = <ErrorState testId="fe2-driveshare-perms-error" error={display} onRetry={() => void query.refetch()} />;
  } else {
    const linkShared = query.data.permissions.some((p) => p.type === "anyone");
    body = (
      <Stack gap={3}>
        <GrantForm fileId={file.id} permsKey={permsKey} />
        <LinkSharingToggle file={file} permsKey={permsKey} linkShared={linkShared} />
        <Stack gap={2}>
          {query.data.permissions.map((p) => (
            <PermissionRow key={p.id} fileId={file.id} permission={p} permsKey={permsKey} />
          ))}
        </Stack>
      </Stack>
    );
  }

  return (
    <section data-testid="fe2-driveshare-panel" aria-label={`${file.name} の共有設定`}>
      <PageHeader title={file.name} description="共有設定" />
      {body}
    </section>
  );
}

export function DriveShareScreen(): JSX.Element {
  const driveApi = useDriveShareApi();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filesKey = queryKeys.feature("driveshare", "files", search);
  const query = useQuery({
    queryKey: filesKey,
    queryFn: () => driveApi.listFiles(search.trim() ? { q: search.trim(), limit: 50 } : { limit: 50 }),
  });

  const files = query.data?.files ?? [];
  const selected = files.find((f) => f.id === selectedId) ?? null;

  let list: JSX.Element;
  if (query.isPending) {
    list = <SkeletonLoader lines={6} />;
  } else if (query.isError) {
    const display = ApiError.isApiError(query.error)
      ? toDisplayableError(query.error)
      : { code: "INTERNAL", message: "ファイルを読み込めませんでした。" };
    list = <ErrorState testId="fe2-driveshare-files-error" error={display} onRetry={() => void query.refetch()} />;
  } else if (files.length === 0) {
    list = (
      <EmptyState
        testId="fe2-driveshare-files-empty"
        title="ファイルがありません"
        description="検索条件を変えるか、共有 Drive にファイルを追加してください。"
        icon="file"
      />
    );
  } else {
    list = (
      <Stack gap={2}>
        {files.map((f) => (
          <FileRow key={f.id} file={f} active={f.id === selectedId} onSelect={() => setSelectedId(f.id)} />
        ))}
      </Stack>
    );
  }

  return (
    <main data-testid="fe2-driveshare">
      <PageHeader title="Drive 共有管理" description="Hackit 共有ドライブの閲覧・編集権限を管理します" />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 1fr) minmax(320px, 1.4fr)", gap: "24px", alignItems: "start" }}>
        <Stack gap={3}>
          <TextField
            id="fe2-driveshare-search"
            testId="fe2-driveshare-search"
            type="text"
            placeholder="ファイル名で検索"
            value={search}
            onChange={setSearch}
          />
          {list}
        </Stack>
        {selected ? (
          <PermissionsPanel file={selected} />
        ) : (
          <EmptyState
            testId="fe2-driveshare-noselection"
            title="ファイルを選択してください"
            description="左のファイルを選ぶと、共有相手と権限を管理できます。"
            icon="users"
          />
        )}
      </div>
    </main>
  );
}
