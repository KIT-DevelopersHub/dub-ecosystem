// ① 一括選択アクションバー. Appears once one or more rows are checked, and applies an
// action to the whole selection (利用停止 / ロール付与). Renders as a fixed bottom-center
// floating toolbar (see BulkActionBar.module.css) so it never reflows the table — the
// row under the cursor stays put when selection toggles.
import { useState } from "react";
import { Button, Select, ConfirmDialog, type SelectOption } from "@dub/ui";
import type { common, identity } from "@dub/types";
import { useBulkSetStatus, useBulkAssignRole } from "../hooks/useBulkUserActions";
import styles from "./BulkActionBar.module.css";

const countStyle: React.CSSProperties = { fontWeight: 600, whiteSpace: "nowrap" };
const groupStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
const spacerStyle: React.CSSProperties = { flex: 1, minWidth: 8 };

export interface BulkActionBarProps {
  selectedIds: common.UserId[];
  roles: identity.Role[];
  canSetStatus: boolean;
  canAssignRole: boolean;
  onClear: () => void;
  testId?: string;
}

export function BulkActionBar({ selectedIds, roles, canSetStatus, canAssignRole, onClear, testId }: BulkActionBarProps) {
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [roleId, setRoleId] = useState<common.RoleId | null>(null);
  const bulkStatus = useBulkSetStatus();
  const bulkAssign = useBulkAssignRole();

  const count = selectedIds.length;
  const busy = bulkStatus.isPending || bulkAssign.isPending;

  const roleOptions: SelectOption[] = roles.map((r) => ({ value: r.id, label: r.name }));

  function applyDisable() {
    bulkStatus.mutate(
      { ids: selectedIds, status: "disabled", verb: "利用停止" },
      { onSettled: () => { setConfirmDisable(false); onClear(); } },
    );
  }

  function applyRole() {
    const role = roles.find((r) => r.id === roleId);
    if (!role) return;
    bulkAssign.mutate(
      { ids: selectedIds, roleId: role.id, roleName: role.name },
      { onSettled: () => { setRoleId(null); onClear(); } },
    );
  }

  return (
    <div className={styles.bar} data-testid={testId} role="region" aria-label="一括操作">
      <span style={countStyle} data-testid={testId ? `${testId}-count` : undefined}>
        {count}件を選択中
      </span>

      <div style={spacerStyle} />

      {canAssignRole ? (
        <div style={groupStyle}>
          <Select
            id="fe7-bulk-role"
            value={roleId}
            options={roleOptions}
            placeholder="ロールを選択"
            onChange={(v) => setRoleId(v as common.RoleId)}
            disabled={busy}
            testId={testId ? `${testId}-role-select` : undefined}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!roleId || busy}
            loading={bulkAssign.isPending}
            onClick={applyRole}
            testId={testId ? `${testId}-role-apply` : undefined}
          >
            ロール付与
          </Button>
        </div>
      ) : null}

      {canSetStatus ? (
        <Button
          variant="danger"
          size="sm"
          disabled={busy}
          loading={bulkStatus.isPending}
          onClick={() => setConfirmDisable(true)}
          testId={testId ? `${testId}-disable` : undefined}
        >
          利用停止
        </Button>
      ) : null}

      <Button variant="ghost" size="sm" onClick={onClear} disabled={busy} testId={testId ? `${testId}-clear` : undefined}>
        選択を解除
      </Button>

      <ConfirmDialog
        open={confirmDisable}
        title="選択したユーザーを利用停止しますか？"
        message={`${count}件のアカウントを利用停止（無効化）します。この操作は各ユーザーのステータスを「停止」に変更します。`}
        confirmLabel="利用停止する"
        cancelLabel="キャンセル"
        danger
        onConfirm={applyDisable}
        onCancel={() => setConfirmDisable(false)}
        testId={testId ? `${testId}-disable-confirm` : undefined}
      />
    </div>
  );
}
