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
  usage: "使用量・課金ガード",
  infra: "インフラ・デプロイ",
  audit: "監査ログ",
  github: "GitHub 連携",
  drive: "Google Drive",
  webhook: "Webhook",
};

// Descriptions are written as an outcome ("オンにすると〜できるようになる") so even
// non-obvious keys make clear what granting them lets a member do.
/** Japanese label + description per permission key. Falls back to catalog text. */
const PERMISSION_LABELS: Record<string, { label: string; description: string }> = {
  "identity:read": { label: "名簿・ロールの閲覧", description: "メンバー一覧・ロール・権限の一覧を見られるようになります。" },
  "identity:admin": { label: "名簿・ロールの管理", description: "メンバーの招待・情報編集、ロールの作成/編集、権限の付与・剥奪ができるようになります。" },
  "event:read": { label: "イベントの閲覧", description: "イベントとその中のアクションを閲覧できるようになります（ガント表示も含む）。" },
  "event:write": { label: "イベントの作成・編集", description: "イベントやアクションを新規作成・編集できるようになります。" },
  "event:admin": { label: "イベントの管理", description: "イベントのアーカイブやクローズなど、状態の変更ができるようになります。" },
  "task:read": { label: "タスクの閲覧", description: "タスクの一覧・詳細を閲覧できるようになります。" },
  "task:write": { label: "タスクの作成・編集", description: "タスクの作成・編集や、タスク間の依存関係の設定ができるようになります。" },
  "task:delete": { label: "タスクの削除", description: "タスクを削除（論理削除・あとから復元可能）できるようになります。" },
  "file:read": { label: "ファイルの閲覧・DL", description: "ファイル情報の閲覧・検索と、ファイルのダウンロードができるようになります。" },
  "file:write": { label: "ファイルの登録・更新", description: "ファイルのアップロード・更新や、他リソースへの紐付けができるようになります。" },
  "file:admin": { label: "ファイルの管理", description: "他人のファイルも含め、公開範囲や所有者の変更・削除ファイルの復元ができるようになります。" },
  "notif:send": { label: "通知の送信", description: "他メンバーへ通知を送信できるようになります。" },
  "notif:admin": { label: "通知の管理", description: "通知の配信履歴を検索・確認できるようになります。" },
  "notif:inbox:self": { label: "自分の受信箱", description: "自分あての通知を受信箱で閲覧・既読管理できるようになります。" },
  "notif:prefs:self": { label: "自分の通知設定", description: "自分の通知の受け取り方（設定）を確認・変更できるようになります。" },
  "notif:broadcast_publish": { label: "メンバーへの通知公開", description: "管理者向けの通知を「Notification管理」画面からメンバー全体へ公開（配信）できるようになります。" },
  "mail:send": { label: "メールの送信", description: "組織のメールアドレスからメールを送信できるようになります。" },
  "mail:read": { label: "メールの閲覧", description: "メールのメッセージ・スレッド・振り分けルールを閲覧できるようになります。" },
  "mail:read_all": { label: "全メールの閲覧（監督）", description: "オンにすると全ユーザーの送受信メールを閲覧できます。" },
  "mail:admin": { label: "メールの管理", description: "メールボックスや受信監視・振り分けルールの設定を管理できるようになります。" },
  "chat:create": { label: "チャンネルの作成", description: "チャットのチャンネルを新規作成できるようになります。" },
  "chat:moderate": { label: "チャットのモデレート", description: "チャンネルの管理や、他人のメッセージの削除ができるようになります。" },
  "usage:view": { label: "使用量ダッシュボードの閲覧", description: "無料枠の使用量・課金ガードのダッシュボードを閲覧できるようになります。" },
  "infra:read": { label: "インフラの閲覧", description: "サイト・デプロイ・DNS・ドメインの状態を閲覧できるようになります。" },
  "infra:deploy": { label: "デプロイの実行", description: "サイトのデプロイ（公開・反映）を実行できるようになります。" },
  "infra:dns": { label: "DNS の変更", description: "ドメインの DNS レコードを変更できるようになります。" },
  "infra:admin": { label: "インフラの管理", description: "サイトの新規登録や、操作を許可するドメインの管理ができるようになります。" },
  "audit:read": { label: "監査ログの閲覧", description: "誰が何をしたかの監査ログを検索・確認できるようになります。" },
  "github:read": { label: "GitHub の閲覧", description: "GitHub の同期状態・リポジトリ・プルリクエストを閲覧できるようになります。" },
  "github:write": { label: "GitHub の更新", description: "同期を通じて GitHub 側のリソースを作成・更新できるようになります。" },
  "github:sync": { label: "GitHub 同期の実行", description: "GitHub との同期処理を手動で実行できるようになります。" },
  "github:admin": { label: "GitHub 連携の管理", description: "GitHub 連携の設定・トークン・Webhook を管理できるようになります。" },
  "drive:read": { label: "Drive の閲覧", description: "Google Drive のファイル情報の閲覧・検索とダウンロードができるようになります。" },
  "drive:write": { label: "Drive の更新", description: "Google Drive へのファイルのアップロード・更新ができるようになります。" },
  "webhook:read": { label: "Webhook の閲覧", description: "Webhook の配信履歴を検索・確認できるようになります。" },
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
