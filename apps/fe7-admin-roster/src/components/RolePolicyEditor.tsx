// ロール 1 件の権限エディタ本体（controlled）。作成画面(RoleEditorPage)と一覧内の
// インライン編集(RolePermissionsEditor)の両方がこれを使うので、権限 UI は 1 実装だけになる。
//
// 構成（上から順に）:
//   1. アプリのアクセス権: アプリごとの 3 段階（無効/閲覧/編集）を表で。画面の軸になる一番上の
//      セクション
//   2. その他: どのアプリにも属さない権限（インフラ・デプロイ / 監査ログ / GitHub 連携 /
//      Webhook）を、1 の下のセクションに
//   3. 詳細ダイアログ: アプリ名クリックで、そのアプリ配下の細かい権限。アプリが「無効」の間は
//      触れない（配下だけ ON の矛盾を作らせない）
//
// 旧 PermissionMatrix（全 60 キーをフラットに並べるトグル grid）と AppAccessSection は
// これに置き換えて削除した。チャットのメッセージ削除ポリシーもこの画面からは撤去済み。
import { useState } from "react";
import type { identity } from "@dub/types";
import { AppAccessTable } from "./AppAccessTable";
import { AppDetailDialog } from "./AppDetailDialog";
import { OtherPermissionsSection } from "./OtherPermissionsSection";

export function RolePolicyEditor({
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
  const [detailAppId, setDetailAppId] = useState<string | null>(null);

  return (
    <div data-testid={`${idPrefix}-role-policy-editor`}>
      <AppAccessTable
        selected={selected}
        disabled={disabled}
        onChange={onChange}
        onOpenDetail={setDetailAppId}
        lockedKeys={lockedKeys}
        idPrefix={idPrefix}
      />
      <OtherPermissionsSection
        selected={selected}
        disabled={disabled}
        onChange={onChange}
        lockedKeys={lockedKeys}
        idPrefix={idPrefix}
      />
      <AppDetailDialog
        appId={detailAppId}
        selected={selected}
        disabled={disabled}
        onChange={onChange}
        onClose={() => setDetailAppId(null)}
        lockedKeys={lockedKeys}
        idPrefix={idPrefix}
      />
    </div>
  );
}
