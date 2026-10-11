// アプリ名クリックで開く「詳細設定」ダイアログ。そのアプリの話は全部ここに入る:
//
//   1. このアプリの権限        … 無効 / 閲覧 / 編集 の 3 段階
//   2. 細かい権限              … APP_MANIFEST の detailPermissions（チャットの「他人の投稿を削除」等）
//
// どちらも policy / APP_MANIFEST 由来なので、アプリや権限を足せばこのダイアログに自動で現れる。
// 細かい権限は「アプリが有効（閲覧以上）」のときだけ触れる = アプリを OFF にしたまま配下だけ
// ON にする、という矛盾した状態を作らせない。
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { Badge, Button, Modal, SegmentedControl } from "@dub/ui";
import { levelLabel, levelDescription, levelTone, type Level } from "../lib/policyLabels";
import { PermissionToggleList } from "./PermissionToggleList";

const blockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-2, 8px)", marginBottom: "var(--dub-space-5, 20px)" };
const headingStyle: React.CSSProperties = { fontWeight: 700, fontSize: 14, margin: 0 };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: 0 };

export function AppDetailDialog({
  appId,
  selected,
  disabled,
  onChange,
  onClose,
  lockedKeys = [],
  idPrefix = "fe7",
}: {
  /** null = 閉じている. */
  appId: string | null;
  selected: readonly identity.PermissionKey[];
  disabled?: boolean;
  onChange: (next: identity.PermissionKey[]) => void;
  onClose: () => void;
  lockedKeys?: readonly identity.PermissionKey[];
  idPrefix?: string;
}) {
  const app = appId ? policy.appPolicyRows(selected).find((r) => r.id === appId) : undefined;
  if (!appId || !app) return null;

  const details = policy.appDetailPermissions(appId);
  const locked = new Set(lockedKeys);
  const levelLocked = locked.has(app.app.access.view) || locked.has(app.app.access.edit);
  // アプリが「無効」なら配下の細かい設定は触れない（policy.decide も app_disabled で落とすので、
  // ここで既存のキーを黙って剥奪はしない＝表示だけロックする）。
  const appOff = app.level === policy.AppAccessLevel.None;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${app.label} の詳細設定`}
      size="lg"
      testId={`${idPrefix}-app-dialog`}
      footer={
        <Button variant="secondary" onClick={onClose} testId={`${idPrefix}-app-dialog-close`}>
          閉じる
        </Button>
      }
    >
      <div style={blockStyle}>
        <h3 style={headingStyle}>このアプリの権限</h3>
        <p style={hintStyle}>{levelDescription(app.level)}</p>
        <SegmentedControl<Level>
          aria-label={`${app.label} の権限`}
          value={app.level}
          onChange={(next) => onChange(policy.setAppAccessLevel(selected, app.id, next))}
          options={policy.APP_ACCESS_LEVELS.map((level) => ({
            value: level,
            label: levelLabel(level),
            disabled: disabled || levelLocked,
            testId: `${idPrefix}-app-dialog-level-${level}`,
          }))}
          testId={`${idPrefix}-app-dialog-level`}
        />
        {levelLocked ? <p style={hintStyle}>このアプリは締め出し防止のため固定されています（変更できません）。</p> : null}
      </div>

      <div style={blockStyle}>
        <h3 style={headingStyle}>細かい権限</h3>
        {details.length === 0 ? (
          <p style={hintStyle} data-testid={`${idPrefix}-app-dialog-no-detail`}>
            このアプリには細かい権限の設定はありません（上の 3 段階だけで決まります）。
          </p>
        ) : (
          <>
            {appOff ? (
              <p style={hintStyle} data-testid={`${idPrefix}-app-dialog-detail-locked`}>
                このアプリは「無効」です。細かい設定を使うには、上の権限を「閲覧」以上にしてください。
              </p>
            ) : (
              <p style={hintStyle}>3 段階に加えて、個別に許可したい操作をここで選びます。</p>
            )}
            <PermissionToggleList
              entries={details}
              selected={selected}
              disabled={disabled || appOff}
              onChange={onChange}
              lockedKeys={lockedKeys}
              testIdPrefix={`${idPrefix}-app-dialog`}
            />
          </>
        )}
      </div>

      <p style={hintStyle}>
        現在: <Badge tone={levelTone(app.level)}>{levelLabel(app.level)}</Badge> / 権限の変更はダイアログを閉じたあと「保存」で確定します。
      </p>
    </Modal>
  );
}
