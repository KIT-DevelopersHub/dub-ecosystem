// Japanese presentation-layer labels for the frozen RBAC permission catalog.
//
// The catalog itself (@dub/types PERMISSION_CATALOG) is a frozen wire contract, so
// its English `name`/`description`/`domain` must NOT change. Instead we localize at
// the point of display: this map turns each `domain` into a feature-group heading
// (メール / 名簿・ロール / 監査 …) and each permission key into a Japanese label +
// one-line description. Any key or domain NOT covered here falls back to the
// catalog's English text, so a future catalog addition never renders blank.
import type { identity } from "@dub/types";
import { appRegistry } from "@dub/types";

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
  lp: "LP管理",
  audit: "監査ログ",
  hr: "人事",
  github: "GitHub 連携",
  drive: "Google Drive",
  calendar: "カレンダー",
  webhook: "Webhook",
  app: "アプリのアクセス権",
};

// Per-app access keys (domain "app"). ロール管理 renders these as the 3 段階 selector
// (無効/閲覧/編集), but effective-permission lists elsewhere render them per-key, so each
// still needs a plain-Japanese label/description.
//
// DERIVED from APP_MANIFEST — never hand-listed. The previous hand-written table had
// drifted whenever an app was registered without being added here (its `app:<id>:*` keys then
// fell back to the catalog's English text) — exactly the 抜け a new app would hit again.
//
// NAME_QUALIFIERS is the ONLY hand-written part: a parenthetical for apps whose launcher
// tile name alone is not self-explanatory in a permission list (Commander is an English
// product name, so 権限一覧 spells out what it governs). Keyed by `AppId`, so a removed or
// renamed app id is a COMPILE error — the derivation stays the source of truth and a new
// app still gets a label automatically, qualifier or not.
const NAME_QUALIFIERS: Partial<Record<appRegistry.AppId, string>> = {
  commander: "開発オペレーション",
};

const APP_LABELS: { id: string; name: string }[] = appRegistry.APP_MANIFEST.map((a) => {
  const qualifier = NAME_QUALIFIERS[a.id];
  return { id: a.id, name: qualifier ? `${a.label}（${qualifier}）` : a.label };
});

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
  "mail:read_role_shared": { label: "同じロールの人宛てのメールを閲覧", description: "オンにすると、このロールを持つ全員が、同じロールのメンバー宛てに届いたメールを閲覧できます。" },
  "mail:admin": { label: "メールの管理", description: "メールボックスや受信監視・振り分けルールの設定を管理できるようになります。" },
  "chat:create": { label: "チャンネルの作成", description: "チャットのチャンネルを新規作成できるようになります。" },
  "chat:moderate": { label: "チャットのモデレート", description: "チャンネルの管理や、他人のメッセージの削除ができるようになります。" },
  "chat:delete_channel": { label: "チャンネルを削除", description: "チャンネルを完全に削除できるようになります（メッセージもすべて消え、元に戻せません）。" },
  "chat:slack_import": { label: "Slack から取り込み", description: "Slack のチャンネルを選んで、メッセージ・スレッド・リアクション・ファイルごとチャットに取り込めるようになります。" },
  "chat:emoji_import": { label: "Slack の絵文字を取り込み", description: "Slack のカスタム絵文字(画像)をチャットに取り込み、リアクションで使えるようにします。" },
  "chat:manage_sections": { label: "セクションを管理", description: "全員に共通のサイドバーのセクションを作成・名前変更・並べ替え・削除し、チャンネルを振り分けられるようになります。" },
  "hr:read": { label: "応募者の閲覧", description: "人事アプリで応募者の情報・面談日・履歴・新メンバーのオンボーディング進捗を見られるようになります（個人情報を含みます）。" },
  "hr:write": { label: "選考の操作", description: "応募者の登録、ステータスの変更、面談日・メモの記録、オンボーディング項目のチェックができるようになります。" },
  "hr:admin": { label: "採用（名簿に追加）・応募の削除", description: "応募者を「採用」にして運営メンバー・名簿に追加したり、応募を削除したりできるようになります。" },
  "usage:view": { label: "使用量ダッシュボードの閲覧", description: "無料枠の使用量・課金ガードのダッシュボードを閲覧できるようになります。" },
  "infra:read": { label: "インフラの閲覧", description: "サイト・デプロイ・DNS・ドメインの状態を閲覧できるようになります。" },
  "infra:deploy": { label: "デプロイの実行", description: "サイトのデプロイ（公開・反映）を実行できるようになります。" },
  "infra:dns": { label: "DNS の変更", description: "ドメインの DNS レコードを変更できるようになります。" },
  "infra:admin": { label: "インフラの管理", description: "サイトの新規登録や、操作を許可するドメインの管理ができるようになります。" },
  "lp:publish": { label: "公開サイトの切り替え", description: "オンにすると、LP管理から hokuriku-it-conf.com に公開する版を切り替えられます。" },
  "audit:read": { label: "監査ログの閲覧", description: "誰が何をしたかの監査ログを検索・確認できるようになります。" },
  "github:read": { label: "GitHub の閲覧", description: "GitHub の同期状態・リポジトリ・プルリクエストを閲覧できるようになります。" },
  "github:write": { label: "GitHub の更新", description: "同期を通じて GitHub 側のリソースを作成・更新できるようになります。" },
  "github:sync": { label: "GitHub 同期の実行", description: "GitHub との同期処理を手動で実行できるようになります。" },
  "github:admin": { label: "GitHub 連携の管理", description: "GitHub 連携の設定・トークン・Webhook を管理できるようになります。" },
  "drive:read": { label: "Drive の閲覧", description: "Google Drive のファイル情報の閲覧・検索とダウンロードができるようになります。" },
  "drive:write": { label: "Drive の更新", description: "Google Drive へのファイルのアップロード・更新ができるようになります。" },
  "drive:settings_view": { label: "Drive共有の設定の閲覧", description: "Drive共有の「設定」を開き、使っている Google アカウントを確認できるようになります。" },
  "drive:settings_edit": { label: "Drive共有の設定の変更", description: "Drive共有が使う Google アカウントの追加・切り替え・削除ができるようになります（保存すると閲覧も ON になります）。" },
  "calendar:schedule_edit": { label: "予定を登録", description: "カレンダーで予定（休暇・ラベル付きの予定など）を追加・変更・削除できるようになります。カレンダーの「編集」と、予定の保存先であるマイタスクの「編集」も必要です。" },
  "calendar:meetings_view": { label: "ミーティングを見る", description: "カレンダーの「ミーティング」で、共有 Google アカウントに設定した定例・会議の一覧を見られるようになります。" },
  "calendar:meetings_edit": { label: "ミーティングを設定", description: "共有 Google アカウントで Meet 付きのミーティングを作成・変更・削除し、ロールのメンバーを自動で招待できるようになります（保存すると「見る」も ON になります）。" },
  "webhook:read": { label: "Webhook の閲覧", description: "Webhook の配信履歴を検索・確認できるようになります。" },
  ...Object.fromEntries(
    APP_LABELS.flatMap((a) => [
      [`app:${a.id}:view`, { label: `${a.name}：有効化（閲覧まで）`, description: `${a.name} アプリを開いて閲覧できるようになります。` }],
      [`app:${a.id}:edit`, { label: `${a.name}：編集・作成まで`, description: `${a.name} アプリ内での作成・編集ができるようになります（閲覧を含みます）。` }],
    ]),
  ),
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
