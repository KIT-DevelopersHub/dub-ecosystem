// 「その他」セクションに並べる組織全体の設定 (ロールに依存しない・保存ボタンを待たず即時反映)。
// 1 件 = その他の表の 1 行 → クリックで同じ形のダイアログ。複数アプリに効く設定はここに置く。
import type { ComponentType } from "react";
import { OAUTH_RETURN_SETTING } from "../lib/oauthReturn";
import { DriveGoogleAccountPanel } from "./DriveGoogleAccountPanel";

export interface OrgSettingPanelProps {
  idPrefix?: string;
}

export interface OrgSettingEntry {
  /** 行とダイアログの見出し / 直リンク ?setting=<id> のキー. */
  id: string;
  label: string;
  Panel: ComponentType<OrgSettingPanelProps>;
}

export const ORG_SETTINGS: readonly OrgSettingEntry[] = [
  // Hackit Drive などが Google を操作するときのアカウント (drive-share-service)
  { id: OAUTH_RETURN_SETTING, label: "Google アカウント", Panel: DriveGoogleAccountPanel },
];

export function orgSetting(id: string | null): OrgSettingEntry | undefined {
  return id ? ORG_SETTINGS.find((s) => s.id === id) : undefined;
}
