// アプリ単位の設定パネルのレジストリ (キー = APP_MANIFEST の AppId)。アプリ固有の設定は
// ロール管理の画面直下ではなく、そのアプリの詳細ダイアログの最下段にここから差し込む。
// パネルはロールに依存しない(全ロール共通の設定)ので、どのロールのダイアログから開いても同じ。
import type { ComponentType } from "react";
import type { appRegistry } from "@dub/types";
import { DriveGoogleAccountPanel } from "./DriveGoogleAccountPanel";

export interface AppSettingsPanelProps {
  idPrefix?: string;
}

export const APP_SETTINGS_PANELS: Partial<Record<appRegistry.AppId, ComponentType<AppSettingsPanelProps>>> = {
  // Drive共有 が使う Google アカウント (drive-share-service)
  driveshare: DriveGoogleAccountPanel,
};

export function appSettingsPanel(appId: string): ComponentType<AppSettingsPanelProps> | undefined {
  return (APP_SETTINGS_PANELS as Record<string, ComponentType<AppSettingsPanelProps> | undefined>)[appId];
}

/** Google の同意画面から戻ったときに詳細ダイアログを開き直すアプリ (OAuth を使うのは Drive共有 だけ)。 */
export const OAUTH_RETURN_APP: appRegistry.AppId = "driveshare";
