// 「その他」の分類（ファイル / デプロイ・DNS / 監査ログ / GitHub 連携 / Webhook）を
// クリックして開く権限ダイアログ。アプリの詳細ダイアログと同じ操作体系にするための片割れで、
// 中身は policy.otherPermissionGroups()（カタログの補集合）なので追加漏れが起きない。
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { Badge, Button, Modal } from "@dub/ui";
import { domainLabel } from "../lib/permissionLabels";
import { PermissionToggleList } from "./PermissionToggleList";

const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: "0 0 var(--dub-space-3, 12px)" };
const footerStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: "var(--dub-space-4, 16px) 0 0" };

export function OtherDetailDialog({
  domain,
  selected,
  disabled,
  onChange,
  onClose,
  lockedKeys = [],
  idPrefix = "fe7",
}: {
  /** null = 閉じている. */
  domain: string | null;
  selected: readonly identity.PermissionKey[];
  disabled?: boolean;
  onChange: (next: identity.PermissionKey[]) => void;
  onClose: () => void;
  lockedKeys?: readonly identity.PermissionKey[];
  idPrefix?: string;
}) {
  const group = domain ? policy.otherPermissionGroups().find((g) => g.domain === domain) : undefined;
  if (!domain || !group) return null;

  const granted = group.entries.filter((e) => selected.includes(e.key as identity.PermissionKey)).length;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${domainLabel(group.domain)} の権限`}
      size="lg"
      testId={`${idPrefix}-other-dialog`}
      footer={
        <Button variant="primary" onClick={onClose} testId={`${idPrefix}-other-dialog-close`}>
          閉じる
        </Button>
      }
    >
      <p style={hintStyle}>
        アプリ単位では表せない、組織全体に効く権限です。必要なものだけを個別に許可します。
      </p>
      <PermissionToggleList
        entries={group.entries}
        selected={selected}
        disabled={disabled}
        onChange={onChange}
        lockedKeys={lockedKeys}
        testIdPrefix={`${idPrefix}-other`}
      />
      <p style={footerStyle}>
        許可: <Badge tone={granted > 0 ? "success" : "neutral"}>{granted} / {group.entries.length}</Badge> /
        変更はダイアログを閉じたあと「保存」で確定します。
      </p>
    </Modal>
  );
}
