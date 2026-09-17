import { useState } from "react";
import {
  PageHeader,
  DataTable,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  SkeletonList,
  type ColumnDef,
} from "@dub/ui";
import type { EmailRoutingAddress } from "../contracts/pending";
import {
  useEmailAddresses,
  useUpdateEmailAddress,
  useDeleteEmailAddress,
  isEmailRoutingUnconfigured,
} from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { NewEmailAddressDialog } from "./NewEmailAddressDialog";
import { displayError } from "../lib/errorDisplay";

const noticeBodyStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const noticeTitleStyle: React.CSSProperties = { fontWeight: 600 };
const noticeTextStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #57606a)", fontSize: 13, margin: 0 };
const skeletonStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };

// メールアドレス管理 — issued @developershub.jp addresses (Cloudflare Email Routing
// receiving rules, forwarding to the mail Worker): list / issue / enable-disable /
// revoke(delete). Same layout family as ロール管理 / ユーザー名簿; admin surface gated
// by mail:admin on the route (routes.tsx) + the manage actions below.
export function EmailAddressManagementPage() {
  const list = useEmailAddresses();
  const update = useUpdateEmailAddress();
  const del = useDeleteEmailAddress();
  const { can } = usePermissions();
  const canManage = can("mail:admin");

  const [newOpen, setNewOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<EmailRoutingAddress | null>(null);

  // The proxy answers 503 MAIL_EMAIL_ROUTING_UNCONFIGURED when the Cloudflare Email
  // Routing token is unset — surface it as a dedicated "未接続" notice (like the
  // roster's sync/preview flow), not the generic ErrorState (which would otherwise
  // read as a transient/upstream failure and invite a pointless retry).
  const notConnected = isEmailRoutingUnconfigured(list.error);

  const columns: ColumnDef<EmailRoutingAddress>[] = [
    {
      key: "address",
      header: "アドレス",
      cell: (a) => <span data-testid={`fe7-email-row-${a.id}`}>{a.address}</span>,
    },
    { key: "destination", header: "転送先", cell: (a) => a.destination },
    {
      key: "status",
      header: "状態",
      cell: (a) =>
        a.enabled ? (
          <Badge tone="success" testId={`fe7-email-status-${a.id}`}>
            有効
          </Badge>
        ) : (
          <Badge tone="neutral" testId={`fe7-email-status-${a.id}`}>
            無効
          </Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      cell: (a) =>
        canManage ? (
          <span style={{ display: "flex", gap: 8 }}>
            <Button
              variant="secondary"
              onClick={() => update.mutate({ id: a.id, req: { enabled: !a.enabled } })}
              disabled={update.isPending}
              testId={`fe7-email-toggle-${a.id}`}
            >
              {a.enabled ? "無効にする" : "有効にする"}
            </Button>
            <Button variant="danger" onClick={() => setPendingDelete(a)} testId={`fe7-email-delete-${a.id}`}>
              削除
            </Button>
          </span>
        ) : null,
    },
  ];

  function confirmDelete() {
    if (!pendingDelete) return;
    del.mutate(pendingDelete.id, { onSettled: () => setPendingDelete(null) });
  }

  return (
    <div>
      <PageHeader
        title="メールアドレス管理"
        description="発行済みの @developershub.jp アドレス（Email Routing の受信ルール）を一覧・発行・停止・削除できます。転送先は常に mail アプリ（このアドレス宛のメールは Dub の受信トレイに届きます）です。"
        testId="fe7-email-header"
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setNewOpen(true)} testId="fe7-email-new">
              メールアドレスを発行
            </Button>
          ) : null
        }
      />

      {notConnected ? (
        <Card testId="fe7-email-unconfigured">
          <div style={noticeBodyStyle}>
            <span style={noticeTitleStyle}>Email Routing に未接続です</span>
            <p style={noticeTextStyle}>
              Cloudflare Email Routing のトークンが未設定のため一覧を取得できません。接続後にもう一度お試しください。
            </p>
          </div>
        </Card>
      ) : list.isLoading ? (
        // Loading MUST show a skeleton, not fall through to EmptyState, so the user
        // can tell "loading" from "no addresses" (FRONTEND_GUIDE §5).
        <div style={skeletonStyle} data-testid="fe7-email-skeleton">
          <SkeletonList rows={4} />
        </div>
      ) : list.isError ? (
        <ErrorState error={displayError(list.error)} onRetry={() => list.refetch()} testId="fe7-email-error" />
      ) : list.data && list.data.items.length === 0 ? (
        <EmptyState title="発行済みのアドレスがありません" testId="fe7-email-empty" />
      ) : (
        <DataTable columns={columns} rows={list.data?.items ?? []} rowKey={(a) => a.id} testId="fe7-email-table" />
      )}

      <NewEmailAddressDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <ConfirmDialog
        title="アドレスを削除"
        message={`「${pendingDelete?.address}」を削除します。このアドレス宛のメールは届かなくなります。よろしいですか？`}
        open={pendingDelete !== null}
        danger
        confirmLabel="削除する"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
        testId="fe7-email-delete-confirm"
      />
    </div>
  );
}
