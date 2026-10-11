// アプリ単位の設定パネルのレジストリ (キー = APP_MANIFEST の AppId)。アプリ固有の設定は
// ロール管理の画面直下ではなく、そのアプリの詳細ダイアログの最下段にここから差し込む。
// パネルはロールに依存しない(全ロール共通の設定)ので、どのロールのダイアログから開いても同じ。
// label は一覧表とダイアログ冒頭の案内に出す(最下段に隠れて見つからないのを防ぐ)。
import type { ComponentType } from "react";
import type { appRegistry } from "@dub/types";
import { DriveGoogleAccountPanel } from "./DriveGoogleAccountPanel";

export interface AppSettingsPanelProps {
  idPrefix?: string;
}

export interface AppSettingsPanelEntry {
  /** 設定の名前 (例: 「Google アカウント」)。 */
  label: string;
  Panel: ComponentType<AppSettingsPanelProps>;
}

export const APP_SETTINGS_PANELS: Partial<Record<appRegistry.AppId, AppSettingsPanelEntry>> = {
  // Drive共有 が使う Google アカウント (drive-share-service)
  driveshare: { label: "Google アカウント", Panel: DriveGoogleAccountPanel },
};

export function appSettingsPanel(appId: string): AppSettingsPanelEntry | undefined {
  return (APP_SETTINGS_PANELS as Record<string, AppSettingsPanelEntry | undefined>)[appId];
}

/** Google の同意画面から戻ったときに詳細ダイアログを開き直すアプリ (OAuth を使うのは Drive共有 だけ)。 */
export const OAUTH_RETURN_APP: appRegistry.AppId = "driveshare";
