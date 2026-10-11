// ロール管理 一番上のセクション「アプリのアクセス権」: アプリごとの 3 段階
//（無効 / 閲覧 / 編集）を「表」で一覧する。
//
// 設計意図（コーディネーター指示）:
//   これまでは 13 アプリぶんのトグル＋入れ子セレクタがカード状に縦積みされていて、
//   「どのアプリがどの段階か」を一望できなかった。チャットのような細かい権限は UI で
//   表現しづらいので、一覧はアプリ × 段階だけに絞り、詳細はアプリ名クリックの
//   ダイアログへ退避させる。行は @dub/types policy.appPolicyRows() が返すので、
//   アプリを新規登録すれば自動で 1 行増える（一覧への追加漏れが構造上起きない）。
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { Badge, Button, DataTable, SegmentedControl } from "@dub/ui";
import type { ColumnDef } from "@dub/ui";
import { levelLabel, levelTone } from "../lib/policyLabels";

type Level = policy.AppAccessLevel;
type Row = policy.AppPolicyRow;

const LEVEL_OPTIONS: readonly Level[] = policy.APP_ACCESS_LEVELS;

// 「その他」セクションと同じカード体裁。2 つが兄弟に見えるように揃える（こちらは画面の
// 一番上なので marginTop は付けない）。
const cardStyle: React.CSSProperties = {
  border: "1px solid var(--dub-color-border-default, #dde1e9)",
  borderRadius: "var(--dub-radius-md, 8px)",
  padding: "var(--dub-space-4, 16px)",
  background: "var(--dub-color-surface-base, #ffffff)",
};
const titleStyle: React.CSSProperties = { fontWeight: 700, fontSize: 15, margin: 0 };
const captionStyle: React.CSSProperties = {
  color: "var(--dub-color-text-muted, #6f7a90)",
  fontSize: 12.5,
  lineHeight: 1.6,
  margin: "var(--dub-space-2, 8px) 0 var(--dub-space-4, 16px)",
};
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
const openHintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 11, fontWeight: 400 };
const lockHintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 11, fontWeight: 600 };
const detailCellStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

export function AppAccessTable({
  selected,
  disabled,
  onChange,
  onOpenDetail,
  lockedKeys = [],
  idPrefix = "fe7",
}: {
  selected: readonly identity.PermissionKey[];
  disabled?: boolean;
  onChange: (next: identity.PermissionKey[]) => void;
  /** アプリ名クリック → 詳細設定ダイアログ. */
  onOpenDetail: (appId: string) => void;
  /** 締め出し防止で固定されているキー（admin ロールの app:admin:*）. */
  lockedKeys?: readonly identity.PermissionKey[];
  idPrefix?: string;
}) {
  const rows = policy.appPolicyRows(selected);
  const summary = policy.appPolicySummary(selected);
  const locked = new Set(lockedKeys);
  const isLocked = (row: Row) => locked.has(row.app.access.view) || locked.has(row.app.access.edit);

  const setLevel = (row: Row, level: Level) => onChange(policy.setAppAccessLevel(selected, row.id, level));

  const columns: ColumnDef<Row>[] = [
    {
      key: "app",
      header: "アプリ",
      minWidth: "14rem",
      hideable: false,
      cell: (row) => (
        <button
          type="button"
          style={nameButtonStyle}
          onClick={() => onOpenDetail(row.id)}
          data-testid={`${idPrefix}-app-name-${row.id}`}
          aria-label={`${row.label} の詳細設定を開く`}
        >
          {row.label}
          {isLocked(row) ? <span style={lockHintStyle}>固定</span> : null}
          {row.openToAll ? <span style={openHintStyle}>全員に公開</span> : null}
        </button>
      ),
    },
    {
      key: "level",
      header: "権限",
      minWidth: "17rem",
      noWrap: true,
      hideable: false,
      cell: (row) => (
        <SegmentedControl<Level>
          size="sm"
          aria-label={`${row.label} の権限`}
          value={row.level}
          onChange={(next) => setLevel(row, next)}
          options={LEVEL_OPTIONS.map((level) => ({
            value: level,
            label: levelLabel(level),
            // 固定アプリ（admin ロールの 管理）は段階を下げられない = 自分の首を切らせない。
            disabled: disabled || isLocked(row),
            testId: `${idPrefix}-app-level-${row.id}-${level}`,
          }))}
          testId={`${idPrefix}-app-level-${row.id}`}
        />
      ),
    },
    {
      key: "state",
      header: "現在",
      minWidth: "6rem",
      noWrap: true,
      cell: (row) => (
        <Badge tone={levelTone(row.level)} testId={`${idPrefix}-app-state-${row.id}`}>
          {levelLabel(row.level)}
        </Badge>
      ),
    },
    {
      key: "detail",
      header: "詳細設定",
      minWidth: "10rem",
      noWrap: true,
      hideable: false,
      // 細かい権限を持つアプリだけ 設定 ボタンを出す。無効なアプリは配下の設定が効かないので
      // 件数を出さず「—」（ボタンは押せるまま = 中身は確認できる）。
      cell: (row) => {
        if (row.detail.total === 0) return <span style={openHintStyle}>なし</span>;
        return (
          <span style={detailCellStyle}>
            <Button variant="secondary" size="sm" onClick={() => onOpenDetail(row.id)} testId={`${idPrefix}-app-detail-${row.id}`}>
              設定
            </Button>
            <span style={openHintStyle} data-testid={`${idPrefix}-app-detail-count-${row.id}`}>
              {row.level === policy.AppAccessLevel.None ? "—" : `${row.detail.granted} / ${row.detail.total}`}
            </span>
          </span>
        );
      },
    },
  ];

  return (
    <section style={cardStyle} data-testid={`${idPrefix}-app-access-table`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={titleStyle}>アプリのアクセス権</h3>
        <span style={countStyle} data-testid={`${idPrefix}-app-access-count`}>
          有効なアプリ: {summary.enabled} / {summary.total}
        </span>
      </div>
      <p style={captionStyle}>
        <strong>無効</strong> = メニューに出ず開けません／<strong>閲覧</strong> = 見られますが作成・編集・削除のボタンは押せません／
        <strong>編集</strong> = 作成・編集まで可能です。
        <br />
        アプリ名をクリックすると、そのアプリの細かい権限（有効なアプリだけ操作できます）が開きます。
      </p>
      <DataTable<Row>
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        testId={`${idPrefix}-app-access-rows`}
      />
    </section>
  );
}
