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
  Tooltip,
  useToast,
} from "@dub/ui";
import { RolePicker } from "@dub/app-ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { createOptimisticMutation } from "../../lib/optimistic.tsx";
import { useDriveShareApi } from "./DriveShareProvider.tsx";
import { DriveTree } from "./DriveTree.tsx";
import {
  driveRoleLabel,
  driveRoleTone,
  isValidEmail,
  roleGrantChipLabel,
  roleLabel,
  type AssignableRole,
  type DriveFile,
  type DriveRole,
  type ListPermissionsResult,
  type ListRoleGrantsResult,
  type RoleFileGrant,
  type ShareRole,
  type SharePermission,
} from "./driveShareApi.tsx";

const ASSIGNABLE_OPTIONS: { value: AssignableRole; label: string }[] = [
  { value: "reader", label: "閲覧者" },
  { value: "commenter", label: "コメント可" },
  { value: "writer", label: "編集者" },
];

// Role grants offer 閲覧(reader)/編集(writer) as the two primary choices; コメント is optional.
const DRIVE_ROLE_OPTIONS: { value: DriveRole; label: string }[] = [
  { value: "reader", label: "閲覧（reader）" },
  { value: "writer", label: "編集（writer）" },
  { value: "commenter", label: "コメント（commenter）" },
];

function roleGrantsKey(fileId: string): readonly unknown[] {
  return queryKeys.feature("driveshare", "role-grants", fileId);
}
const ALL_ROLE_GRANTS_KEY = queryKeys.feature("driveshare", "role-grants");

function formatUpdated(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

/** Color chips summarising a file's role grants (e.g. 「開発: 編集」「会場: 閲覧」). */
function RoleGrantChips({ grants }: { grants: readonly RoleFileGrant[] }): JSX.Element | null {
  if (grants.length === 0) return null;
  return (
    <Stack direction="row" gap={1} align="center" wrap testId="fe2-driveshare-file-chips">
      {grants.map((g) => (
        <Badge key={g.id} tone={driveRoleTone(g.driveRole)} testId="fe2-driveshare-file-chip">
          {roleGrantChipLabel(g)}
        </Badge>
      ))}
    </Stack>
  );
}

function FileRow({
  file,
  active,
  grants,
  onSelect,
}: {
  file: DriveFile;
  active: boolean;
  grants: readonly RoleFileGrant[];
  onSelect: () => void;
}): JSX.Element {
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
            <Icon name={file.isFolder ? "folder" : "file"} />
            <strong style={{ fontWeight: active ? 700 : 500 }}>{file.name}</strong>
            {file.linkShared ? (
              <Badge tone="info" testId="fe2-driveshare-linkbadge">
                リンク共有中
              </Badge>
            ) : null}
          </Stack>
          <RoleGrantChips grants={grants} />
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
  const isInherited = !isOwner && permission.inherited;
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
          {isInherited ? (
            <small data-testid="fe2-driveshare-inherited-reason" style={{ color: "var(--dub-color-fg-muted, #667)" }}>
              親フォルダから継承された権限のため、このファイル単体では変更・剥奪できません。親フォルダの共有設定で操作してください。
            </small>
          ) : null}
        </Stack>
        <Stack direction="row" gap={2} align="center">
          {isOwner ? (
            <Badge tone="neutral">{roleLabel(permission.role)}</Badge>
          ) : isInherited ? (
            <Stack direction="row" gap={2} align="center">
              <Badge tone="neutral">{roleLabel(permission.role)}</Badge>
              <Tooltip content="親フォルダから継承された権限です。このファイル単体では変更・剥奪できません。親フォルダの共有設定で操作してください。">
                <Badge tone="warning" testId="fe2-driveshare-inherited-badge">
                  継承
                </Badge>
              </Tooltip>
            </Stack>
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
  linkInherited,
}: {
  file: DriveFile;
  permsKey: readonly unknown[];
  linkShared: boolean;
  /** The existing `anyone` permission is inherited from a parent folder → it cannot be
   *  removed on this item, so the toggle is locked on with an explanation. */
  linkInherited: boolean;
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
          {linkInherited ? (
            <small data-testid="fe2-driveshare-link-inherited-reason" style={{ color: "var(--dub-color-fg-muted, #667)" }}>
              リンク共有は親フォルダから継承されています。このファイル単体ではオフにできません。親フォルダの共有設定で操作してください。
            </small>
          ) : null}
        </Stack>
        <Switch
          id={`fe2-driveshare-link-${file.id}`}
          testId="fe2-driveshare-link-switch"
          checked={linkShared}
          disabled={toggle.isPending || linkInherited}
          label="リンク共有"
          onChange={(enabled) => toggle.mutate(enabled)}
        />
      </Stack>
    </Card>
  );
}

/** Report a role apply/reapply outcome. A partial success (some members Drive refused —
 *  no Google account / invalid email) is a WARNING that names the skipped members with a
 *  reason, so nothing fails silently and the operator knows exactly who to fix. */
function showRoleGrantOutcome(
  toast: ReturnType<typeof useToast>,
  grant: RoleFileGrant,
  okTitle: string,
  opts: { silentOnSuccess?: boolean } = {},
): void {
  const skipped = grant.skipped ?? [];
  if (skipped.length === 0) {
    if (!opts.silentOnSuccess) toast.show({ kind: "success", title: okTitle });
    return;
  }
  const shown = skipped.slice(0, 4).map((s) => `${s.email}（${s.reason}）`).join(" / ");
  const more = skipped.length > 4 ? ` 他${skipped.length - 4}件` : "";
  toast.show({
    kind: "warning",
    title: `${okTitle}（${skipped.length}人はスキップ）`,
    description: `付与 ${grant.appliedCount}人・スキップ ${skipped.length}人: ${shown}${more}`,
  });
}

function RoleGrantRow({
  fileId,
  grant,
  grantsKey,
}: {
  fileId: string;
  grant: RoleFileGrant;
  grantsKey: readonly unknown[];
}): JSX.Element {
  const driveApi = useDriveShareApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  // Re-apply is optimistic: assume the sync reaches every member (appliedCount → memberCount).
  const reapply = useMutation(
    createOptimisticMutation<RoleFileGrant, void, ListRoleGrantsResult>(queryClient, {
      mutationFn: () => driveApi.reapplyRoleGrant(fileId, grant.roleId),
      cacheKey: grantsKey,
      applyOptimistic: (prev) => ({
        ...prev,
        items: prev.items.map((g) => (g.roleId === grant.roleId ? { ...g, appliedCount: g.memberCount } : g)),
      }),
      onErrorToast: (err) => toast.show({ kind: "error", title: "再適用できませんでした", description: err.message }),
    }),
  );

  // Revoke is destructive → non-optimistic behind ConfirmDialog (optimistic.tsx convention).
  const revoke = useMutation({
    mutationFn: () => driveApi.revokeRoleGrant(fileId, grant.roleId),
    onSuccess: () => {
      toast.show({ kind: "success", title: "ロールの割り当てを解除しました", description: `${grant.roleName}` });
      void queryClient.invalidateQueries({ queryKey: grantsKey });
      void queryClient.invalidateQueries({ queryKey: ALL_ROLE_GRANTS_KEY });
    },
    onError: (err) =>
      toast.show({
        kind: "error",
        title: "解除できませんでした",
        description: ApiError.isApiError(err) ? err.message : undefined,
      }),
  });

  const reapplyThenSyncChips = (): void => {
    reapply.mutate(undefined, {
      // Silent on a clean reapply (it was already optimistic); warn only if Drive refused some members.
      onSuccess: (result) => showRoleGrantOutcome(toast, result, "再適用しました", { silentOnSuccess: true }),
      onSettled: () => void queryClient.invalidateQueries({ queryKey: ALL_ROLE_GRANTS_KEY }),
    });
  };

  return (
    <Card testId="fe2-driveshare-role-grant">
      <Stack direction="row" gap={2} align="center" justify="between">
        <Stack gap={1}>
          <Stack direction="row" gap={2} align="center">
            <strong>{grant.roleName}</strong>
            <Badge tone={driveRoleTone(grant.driveRole)} testId="fe2-driveshare-role-grant-badge">
              {driveRoleLabel(grant.driveRole)}
            </Badge>
          </Stack>
          <small data-testid="fe2-driveshare-role-grant-members">{grant.memberCount}人に展開</small>
        </Stack>
        <Stack direction="row" gap={2} align="center">
          <Button
            variant="secondary"
            testId="fe2-driveshare-role-grant-reapply"
            loading={reapply.isPending}
            onClick={reapplyThenSyncChips}
          >
            再適用
          </Button>
          <Button
            variant="danger"
            testId="fe2-driveshare-role-grant-revoke"
            loading={revoke.isPending}
            onClick={() => setConfirmRevoke(true)}
          >
            解除
          </Button>
        </Stack>
      </Stack>
      <ConfirmDialog
        open={confirmRevoke}
        testId="fe2-driveshare-role-grant-revoke-confirm"
        title="ロールの割り当てを解除しますか？"
        message={`「${grant.roleName}」の${driveRoleLabel(grant.driveRole)}権限（${grant.memberCount}人）を解除します。`}
        confirmLabel="解除する"
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

function RolePermissionPanel({ file, grantsKey }: { file: DriveFile; grantsKey: readonly unknown[] }): JSX.Element {
  const driveApi = useDriveShareApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [roleId, setRoleId] = useState("");
  const [driveRole, setDriveRole] = useState<DriveRole>("reader");

  const rolesQuery = useQuery({
    queryKey: queryKeys.feature("driveshare", "roles"),
    queryFn: () => driveApi.listRoles(),
  });
  const grantsQuery = useQuery({
    queryKey: grantsKey,
    queryFn: () => driveApi.listRoleGrants(file.id),
  });

  const roles = rolesQuery.data?.items ?? [];
  const grants = grantsQuery.data?.items ?? [];
  const alreadyGranted = new Set(grants.map((g) => g.roleId));

  // Optimistic grant: insert a placeholder grant (memberCount unknown until refetch).
  const grantRole = useMutation(
    createOptimisticMutation<RoleFileGrant, { roleId: string; driveRole: DriveRole }, ListRoleGrantsResult>(queryClient, {
      mutationFn: (req) => driveApi.grantRole(file.id, req),
      cacheKey: grantsKey,
      applyOptimistic: (prev, req) => {
        const roleName = roles.find((r) => r.id === req.roleId)?.name ?? req.roleId;
        const optimistic: RoleFileGrant = {
          id: `optimistic-${req.roleId}`,
          fileId: file.id,
          roleId: req.roleId,
          roleName,
          driveRole: req.driveRole,
          memberCount: 0,
          appliedCount: 0,
          grantedBy: "",
          grantedAt: new Date().toISOString(),
        };
        const withoutDup = prev.items.filter((g) => g.roleId !== req.roleId);
        return { ...prev, items: [...withoutDup, optimistic] };
      },
      onErrorToast: (err) => toast.show({ kind: "error", title: "ロールに振れませんでした", description: err.message }),
    }),
  );

  const submit = (): void => {
    if (!roleId) return;
    const roleName = roles.find((r) => r.id === roleId)?.name ?? roleId;
    grantRole.mutate(
      { roleId, driveRole },
      {
        onSuccess: (result) => {
          showRoleGrantOutcome(toast, result, `${roleName} を${driveRoleLabel(driveRole)}に設定`);
          setRoleId("");
          setDriveRole("reader");
        },
        onSettled: () => void queryClient.invalidateQueries({ queryKey: ALL_ROLE_GRANTS_KEY }),
      },
    );
  };

  const canSubmit = roleId.length > 0 && !alreadyGranted.has(roleId) && !grantRole.isPending;

  let grantList: JSX.Element;
  if (grantsQuery.isPending) {
    grantList = <SkeletonLoader lines={2} />;
  } else if (grantsQuery.isError) {
    const display = ApiError.isApiError(grantsQuery.error)
      ? toDisplayableError(grantsQuery.error)
      : { code: "INTERNAL", message: "ロール権限を読み込めませんでした。" };
    grantList = <ErrorState testId="fe2-driveshare-role-grants-error" error={display} onRetry={() => void grantsQuery.refetch()} />;
  } else if (grants.length === 0) {
    grantList = (
      <EmptyState
        testId="fe2-driveshare-role-grants-empty"
        title="ロール権限はまだありません"
        description="ロールを選んで「このロールに振る」と、そのロールのメンバー全員へ一括で権限が展開されます。"
        icon="users"
      />
    );
  } else {
    grantList = (
      <Stack gap={2}>
        {grants.map((g) => (
          <RoleGrantRow key={g.id} fileId={file.id} grant={g} grantsKey={grantsKey} />
        ))}
      </Stack>
    );
  }

  return (
    <Card testId="fe2-driveshare-role-panel">
      <Stack gap={3}>
        <strong>ロールで共有を追加</strong>
        {rolesQuery.isPending ? (
          <SkeletonLoader lines={2} />
        ) : rolesQuery.isError ? (
          <ErrorState
            testId="fe2-driveshare-roles-error"
            error={
              ApiError.isApiError(rolesQuery.error)
                ? toDisplayableError(rolesQuery.error)
                : { code: "INTERNAL", message: "ロールを読み込めませんでした。" }
            }
            onRetry={() => void rolesQuery.refetch()}
          />
        ) : (
          <Stack direction="row" gap={2} align="end">
            <RolePicker
              id="fe2-driveshare-role-picker"
              testId="fe2-driveshare-role-picker"
              value={roleId}
              onChange={setRoleId}
              roles={roles}
              includeNone
              noneLabel="ロールを選択"
            />
            <Select<DriveRole>
              id="fe2-driveshare-role-driverole"
              testId="fe2-driveshare-role-driverole"
              value={driveRole}
              options={DRIVE_ROLE_OPTIONS}
              onChange={setDriveRole}
            />
            <Button testId="fe2-driveshare-role-submit" disabled={!canSubmit} loading={grantRole.isPending} onClick={submit}>
              このロールに振る
            </Button>
          </Stack>
        )}
        {roleId && alreadyGranted.has(roleId) ? (
          <small style={{ color: "var(--dub-color-danger-fg, #b00)" }}>このロールには既に権限が設定されています</small>
        ) : null}
        {grantList}
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
    const anyonePerm = query.data.permissions.find((p) => p.type === "anyone");
    const linkShared = anyonePerm !== undefined;
    const linkInherited = anyonePerm?.inherited ?? false;
    body = (
      <Stack gap={3}>
        <GrantForm fileId={file.id} permsKey={permsKey} />
        <RolePermissionPanel file={file} grantsKey={roleGrantsKey(file.id)} />
        <LinkSharingToggle file={file} permsKey={permsKey} linkShared={linkShared} linkInherited={linkInherited} />
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
  // The selected node's full DriveFile (not just an id): a nested child lives in a
  // per-folder cache, not the root list, so the panel must hold the object itself.
  const [selected, setSelected] = useState<DriveFile | null>(null);
  const trimmed = search.trim();
  const searching = trimmed.length > 0;
  const filesKey = queryKeys.feature("driveshare", "files", search);
  const query = useQuery({
    queryKey: filesKey,
    queryFn: () => driveApi.listFiles(searching ? { q: trimmed, limit: 50 } : { limit: 50 }),
  });

  // Fetch every role grant once and index by fileId so each row can show its chips.
  const allGrantsQuery = useQuery({
    queryKey: ALL_ROLE_GRANTS_KEY,
    queryFn: () => driveApi.listAllRoleGrants(),
  });
  const grantsByFile = new Map<string, RoleFileGrant[]>();
  for (const g of allGrantsQuery.data?.items ?? []) {
    const list = grantsByFile.get(g.fileId);
    if (list) list.push(g);
    else grantsByFile.set(g.fileId, [g]);
  }
  const grantsFor = (fileId: string): RoleFileGrant[] => grantsByFile.get(fileId) ?? [];

  const files = query.data?.files ?? [];
  const selectedId = selected?.id ?? null;

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
  } else if (searching) {
    // While searching we show a FLAT substring result across every depth (folders are
    // not expandable here). Auto-expanding the tree to each hit is a future improvement.
    list = (
      <Stack gap={2}>
        {files.map((f) => (
          <FileRow key={f.id} file={f} active={f.id === selectedId} grants={grantsFor(f.id)} onSelect={() => setSelected(f)} />
        ))}
      </Stack>
    );
  } else {
    // Default view: the lazy, expandable hierarchy.
    list = <DriveTree files={files} selectedId={selectedId} onSelect={setSelected} grantsFor={grantsFor} />;
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
