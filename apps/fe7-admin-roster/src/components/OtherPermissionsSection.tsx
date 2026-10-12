// 画面の下側の「その他」セクション: どのアプリにも属さない、組織全体に効く権限
//（インフラ・デプロイ / 監査ログ / GitHub 連携 / Webhook）。
//
// 中身は「どのアプリも detailPermissions で拾わなかったカタログキー」= policy.otherPermissions()
// の補集合計算なので、将来カタログにキーが増えたら自動でここに現れる（UI から権限が消える抜けが
// 構造上起きない）。分類名もハードコードせず rows から組み立てる。
//
// 見せ方はアプリ一覧表と同じ「1 行 → クリックで詳細ダイアログ」に揃えてある。以前はここに 13 個の
// トグルを全部展開していたので、アプリ一覧表よりこのエリアの方が長く、画面上部に項目が多すぎる
// 状態だった。ロール管理の画面直下はアプリ表とこの表の 2 つだけ、細かい ON/OFF は必ずダイアログ。
//
// 表の末尾には組織全体の設定 (orgSettingsPanels.tsx・Google アカウント等) も同じ形で並ぶ。
// こちらはロールの権限ではないので「許可」は —、変更は保存を待たず即時反映。
import { useState } from "react";
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { Badge, Button, DataTable } from "@dub/ui";
import type { ColumnDef } from "@dub/ui";
import { domainLabel } from "../lib/permissionLabels";
import { OtherDetailDialog } from "./OtherDetailDialog";
import { OrgSettingDialog } from "./OrgSettingDialog";
import { ORG_SETTINGS } from "./orgSettingsPanels";
import { OAUTH_RETURN_SETTING, clearLinkedSetting, linkedSetting, pendingOAuthReturnSetting } from "../lib/oauthReturn";

interface GroupRow {
  /** permission = 権限の分類 (domain) / setting = 組織全体の設定 (ORG_SETTINGS の id). */
  kind: "permission" | "setting";
  domain: string;
  label: string;
  granted: number;
  total: number;
  /** 「注意」付き（危険）キーを含むグループ = 行にも注意を出す. */
  dangerous: boolean;
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--dub-color-border-default, #dde1e9)",
  borderRadius: "var(--dub-radius-md, 8px)",
  padding: "var(--dub-space-4, 16px)",
  marginTop: "var(--dub-space-6, 24px)",
  background: "var(--dub-color-surface-base, #ffffff)",
};
const titleStyle: React.CSSProperties = { fontWeight: 700, fontSize: 15, margin: 0 };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: "var(--dub-space-2, 8px) 0 var(--dub-space-4, 16px)" };
const countStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 13, marginLeft: "auto" };
const nameButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  fontWeight: 600,
  color: "var(--dub-color-text-link, #2f5cff)",
  cursor: "pointer",
  textAlign: "left",
};
const detailCellStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const mutedStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 11, fontWeight: 400 };

export function OtherPermissionsSection({
  selected,
  disabled,
  onChange,
  lockedKeys = [],
  idPrefix = "fe7",
}: {
  selected: readonly identity.PermissionKey[];
  disabled?: boolean;
  onChange: (next: identity.PermissionKey[]) => void;
  lockedKeys?: readonly identity.PermissionKey[];
  idPrefix?: string;
}) {
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  // Google の同意画面から戻った直後 / 直リンク ?setting= のときは、その設定ダイアログを開いておく。
  const [openSetting, setOpenSetting] = useState<string | null>(
    () => pendingOAuthReturnSetting(OAUTH_RETURN_SETTING) ?? linkedSetting(),
  );
  const open = (row: GroupRow) => (row.kind === "setting" ? setOpenSetting(row.domain) : setOpenDomain(row.domain));
  const closeSetting = () => {
    setOpenSetting(null);
    clearLinkedSetting();
  };

  const all = policy.otherPermissions();
  const grantedCount = all.filter((e) => selected.includes(e.key as identity.PermissionKey)).length;
  const permissionRows: GroupRow[] = policy.otherPermissionGroups().map((group) => ({
    kind: "permission",
    domain: group.domain,
    label: domainLabel(group.domain),
    granted: group.entries.filter((e) => selected.includes(e.key as identity.PermissionKey)).length,
    total: group.entries.length,
    dangerous: group.entries.some((e) => e.dangerous),
  }));
  const settingRows: GroupRow[] = ORG_SETTINGS.map((setting) => ({
    kind: "setting",
    domain: setting.id,
    label: setting.label,
    granted: 0,
    total: 0,
    dangerous: false,
  }));
  const rows = [...permissionRows, ...settingRows];

  const columns: ColumnDef<GroupRow>[] = [
    {
      key: "group",
      header: "分類",
      minWidth: "14rem",
      hideable: false,
      cell: (row) => (
        <button
          type="button"
          style={nameButtonStyle}
          onClick={() => open(row)}
          data-testid={`${idPrefix}-other-name-${row.domain}`}
          aria-label={row.kind === "setting" ? `${row.label} の設定を開く` : `${row.label} の権限を開く`}
        >
          {row.label}
          {row.dangerous ? <span style={mutedStyle}>注意を含む</span> : null}
        </button>
      ),
    },
    {
      key: "granted",
      header: "許可",
      minWidth: "7rem",
      noWrap: true,
      cell: (row) =>
        row.kind === "setting" ? (
          <span style={mutedStyle}>—</span>
        ) : (
          <Badge tone={row.granted > 0 ? "success" : "neutral"} testId={`${idPrefix}-other-granted-${row.domain}`}>
            {row.granted} / {row.total}
          </Badge>
        ),
    },
    {
      key: "detail",
      header: "設定",
      minWidth: "8rem",
      noWrap: true,
      hideable: false,
      cell: (row) => (
        <span style={detailCellStyle}>
          <Button variant="secondary" size="sm" onClick={() => open(row)} testId={`${idPrefix}-other-detail-${row.domain}`}>
            設定
          </Button>
        </span>
      ),
    },
  ];

  return (
    <section style={cardStyle} data-testid={`${idPrefix}-other-permissions`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={titleStyle}>その他（どのアプリにも属さない権限・設定）</h3>
        <span style={countStyle} data-testid={`${idPrefix}-other-count`}>
          {grantedCount} / {all.length} 許可
        </span>
      </div>
      <p style={hintStyle}>
        {permissionRows.map((row) => row.label).join(" / ")} のような、特定のアプリではなく組織全体に効く権限です。
        分類をクリックして個別に許可します。
      </p>
      <DataTable<GroupRow>
        columns={columns}
        rows={rows}
        rowKey={(row) => row.domain}
        testId={`${idPrefix}-other-rows`}
      />
      <OtherDetailDialog
        domain={openDomain}
        selected={selected}
        disabled={disabled}
        onChange={onChange}
        onClose={() => setOpenDomain(null)}
        lockedKeys={lockedKeys}
        idPrefix={idPrefix}
      />
      <OrgSettingDialog settingId={openSetting} onClose={closeSetting} idPrefix={idPrefix} />
    </section>
  );
}
