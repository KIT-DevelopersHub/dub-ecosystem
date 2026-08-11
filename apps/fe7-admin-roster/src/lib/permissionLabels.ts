// Japanese presentation-layer labels for the frozen RBAC permission catalog.
//
// The catalog itself (@dub/types PERMISSION_CATALOG) is a frozen wire contract, so
// its English `name`/`description`/`domain` must NOT change. Instead we localize at
// the point of display: this map turns each `domain` into a feature-group heading
// (メール / 名簿・ロール / 監査 …) and each permission key into a Japanese label +
// one-line description. Any key or domain NOT covered here falls back to the
// catalog's English text, so a future catalog addition never renders blank.
import type { identity } from "@dub/types";

/** Feature-group heading per catalog `domain`. Falls back to the raw domain. */
const DOMAIN_LABELS: Record<string, string> = {
  identity: "名簿・ロール",
  event: "イベント",
  task: "タスク",
  file: "ファイル",
  notif: "通知",
  mail: "メール",
  chat: "チャット",
  infra: "インフラ・デプロイ",
  audit: "監査ログ",
  github: "GitHub 連携",
  drive: "Google Drive",
  webhook: "Webhook",
};

/** Japanese label + description per permission key. Falls back to catalog text. */
const PERMISSION_LABELS: Record<string, { label: string; description: string }> = {
  "identity:read": { label: "名簿・ロールの閲覧", description: "メンバー一覧・ロール・権限カタログを閲覧" },
  "identity:admin": { label: "名簿・ロールの管理", description: "ユーザー招待・ロール編集・権限の付与/剥奪" },
  "event:read": { label: "イベントの閲覧", description: "イベント／アクションを閲覧（ガント表示も含む）" },
  "event:write": { label: "イベントの作成・編集", description: "イベントとアクションの作成・更新" },
  "event:admin": { label: "イベントの管理", description: "アーカイブ・クローズなどの状態変更" },
  "task:read": { label: "タスクの閲覧", description: "タスクを閲覧" },
  "task:write": { label: "タスクの作成・編集", description: "タスクの作成・更新・依存関係の編集" },
  "task:delete": { label: "タスクの削除", description: "タスクの論理削除" },
  "file:read": { label: "ファイルの閲覧・DL", description: "メタデータの閲覧／検索と R2 からのダウンロード" },
  "file:write": { label: "ファイルの登録・更新", description: "登録・更新・リンク・アップロード" },
  "file:admin": { label: "ファイルの管理", description: "公開範囲／所有者の変更・復元" },
  "notif:send": { label: "通知の送信", description: "通知を送信（サービス間）" },
  "notif:admin": { label: "通知の管理", description: "配信記録の検索" },
  "notif:inbox:self": { label: "自分の受信箱", description: "自分の通知受信箱の閲覧・操作" },
  "notif:prefs:self": { label: "自分の通知設定", description: "自分の通知設定の閲覧・更新" },
  "mail:send": { label: "メールの送信", description: "メールを送信" },
  "mail:read": { label: "メールの閲覧", description: "メッセージ／スレッド／ルールを閲覧" },
  "mail:admin": { label: "メールの管理", description: "メールボックス／監視／ルールの管理" },
  "chat:create": { label: "チャンネルの作成", description: "チャットチャンネルを作成" },
  "chat:moderate": { label: "チャットのモデレート", description: "チャンネル管理・他者メッセージの削除" },
  "infra:read": { label: "インフラの閲覧", description: "サイト／デプロイ／DNS／ドメインの閲覧" },
  "infra:deploy": { label: "デプロイの実行", description: "デプロイを実行" },
  "infra:dns": { label: "DNS の変更", description: "DNS レコードの変更" },
  "infra:admin": { label: "インフラの管理", description: "サイト登録・許可ゾーンの管理" },
  "audit:read": { label: "監査ログの閲覧", description: "監査記録の検索／照会" },
  "github:read": { label: "GitHub の閲覧", description: "GitHub 同期状態・リポジトリ・PR の閲覧" },
  "github:write": { label: "GitHub の更新", description: "同期経由で GitHub 側リソースを作成／更新" },
  "github:sync": { label: "GitHub 同期の実行", description: "GitHub 同期ジョブを起動" },
  "github:admin": { label: "GitHub 連携の管理", description: "連携・トークン・Webhook の管理" },
  "drive:read": { label: "Drive の閲覧", description: "Google Drive メタデータの閲覧／検索・DL" },
  "drive:write": { label: "Drive の更新", description: "Google Drive ファイルのアップロード／更新" },
  "webhook:read": { label: "Webhook の閲覧", description: "Webhook 配信記録の検索" },
};

/** Japanese feature-group heading for a catalog domain (English domain fallback). */
export function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? domain;
}

/** Japanese label for a permission key, falling back to the catalog's English name. */
export function permissionLabel(key: string, fallbackName: string): string {
  return PERMISSION_LABELS[key]?.label ?? fallbackName;
}

/** Japanese description for a permission key, falling back to the catalog description. */
export function permissionDescription(key: string, fallbackDescription: string): string {
  return PERMISSION_LABELS[key]?.description ?? fallbackDescription;
}

export type { identity };
