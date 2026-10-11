// アプリ名クリックで開く「詳細設定」ダイアログ。そのアプリの話は全部ここに入る:
//
//   1. このアプリの権限        … 無効 / 閲覧 / 編集 の 3 段階
//   2. 細かい権限              … APP_MANIFEST の detailPermissions（チャットの「他人の投稿を削除」等）
//   3. アプリ固有の設定        … appSettingsPanels.tsx に登録があるアプリだけ最下段に出る
//                                （Drive共有 の Google アカウント等。全ロール共通・即時反映）
//
// どちらも policy / APP_MANIFEST 由来なので、アプリや権限を足せばこのダイアログに自動で現れる。
// 細かい権限は「アプリが有効（閲覧以上）」のときだけ触れる = アプリを OFF にしたまま配下だけ
// ON にする、という矛盾した状態を作らせない。
import { useEffect } from "react";
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { Badge, Button, Modal, SegmentedControl } from "@dub/ui";
import { levelLabel, levelDescription, levelTone, type Level } from "../lib/policyLabels";
import { PermissionToggleList } from "./PermissionToggleList";
import { appSettingsPanel } from "./appSettingsPanels";

const blockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-2, 8px)", marginBottom: "var(--dub-space-5, 20px)" };
const headingStyle: React.CSSProperties = { fontWeight: 700, fontSize: 14, margin: 0 };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: 0 };
const jumpRowStyle: React.CSSProperties = {
  ...hintStyle,
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "var(--dub-space-2, 8px)",
  padding: "var(--dub-space-2, 8px) var(--dub-space-3, 12px)",
  marginBottom: "var(--dub-space-5, 20px)",
  borderRadius: "var(--dub-radius-md, 8px)",
  background: "var(--dub-color-surface-subtle, #f5f7fa)",
};

export function AppDetailDialog({
  appId,
  selected,
  disabled,
  onChange,
  onClose,
  lockedKeys = [],
  idPrefix = "fe7",
  focusSettings,
}: {
  /** null = 閉じている. */
  appId: string | null;
  /** 開いた直後に最下段のアプリ固有設定までスクロールする (直リンク用). */
  focusSettings?: boolean;
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
  const settings = appSettingsPanel(appId);
  const settingsId = `${idPrefix}-app-settings-${appId}`;

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
      {settings ? (
        <p style={jumpRowStyle} data-testid={`${idPrefix}-app-dialog-settings-hint`}>
          このアプリには「{settings.label}」の設定もあります（全ロール共通・一番下）。
          <Button variant="ghost" size="sm" onClick={() => scrollToSettings(settingsId)} testId={`${idPrefix}-app-dialog-settings-jump`}>
            {settings.label}へ移動
          </Button>
        </p>
      ) : null}

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

      {settings ? (
        <SettingsSection id={settingsId} focus={focusSettings}>
          <settings.Panel idPrefix={idPrefix} />
        </SettingsSection>
      ) : null}
    </Modal>
  );
}

function scrollToSettings(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

/** 最下段の設定。直リンク (?app=) で開いたときは最初からここを見せる。 */
function SettingsSection({ id, focus, children }: { id: string; focus?: boolean; children: React.ReactNode }) {
  useEffect(() => {
    if (focus) scrollToSettings(id);
  }, [id, focus]);
  return (
    <div id={id} style={{ scrollMarginTop: "var(--dub-space-4, 16px)" }}>
      {children}
    </div>
  );
}
