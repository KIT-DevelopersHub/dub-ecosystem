# スポンサーアプリ（スポンサーチーム向け）設計

## 目次

- [目的とスコープ](#目的とスコープ)
- [使い方の流れ](#使い方の流れ)
- [データモデル](#データモデル)
- [権限（ロール管理）](#権限ロール管理)
- [API](#api)
- [フロントエンド](#フロントエンド)
- [リリース手順と migration](#リリース手順と-migration)
- [フェーズ2 以降の TODO](#フェーズ2-以降の-todo)

## 目的とスコープ

スポンサーチームが展示会・企業訪問などで受け取った名刺を、その場でスマホのカメラで撮って登録し、
チームの全員がすぐ見られるようにする。名刺がメンバー個人の手元に眠り、誰がどの企業と接点を持っているか
分からなくなるのを防ぐ。

フェーズ1（この PR）: 名刺の撮影（カメラ / 写真を選ぶ）・連絡先とメモの登録・一覧/検索・詳細（編集・撮り直し・削除）・
ランチャー/ロール管理への登録・demo。

**文字の自動読み取り（OCR）はフェーズ2**。写真だけでも登録でき、連絡先は手入力（すべて任意）。

## 使い方の流れ

1. `/sponsor` の「名刺をスキャン」→ カメラの映像に名刺の枠（91:55）が出る → シャッター → 「この写真を使う」。
   カメラが使えない端末（PC・権限拒否）は「写真を選ぶ」で撮影済みの写真を使う。
2. 会社名・氏名・部署・役職・メール・電話・メモ（どこで交換したか・協賛の温度感など）を入力して保存（すべて任意）。
3. 権限のあるメンバー全員の一覧に出る。詳細からメール / 電話へ直接つなげる。

写真は端末側で長辺 1600px の JPEG に縮小してから送る（通信量と保存量を抑える）。

## データモデル

D1 `member` namespace に新規テーブル 1 つ（`infra/d1/migrations/member/0019_sponsor_cards.sql`、additive）。

| テーブル | 役割 |
|---|---|
| `member_sponsor_cards` | 名刺。会社名・氏名・部署・役職・メール・電話・メモ・写真の形式（`image_content_type`、NULL = 写真なし）・登録者（`created_by` と登録時点の名簿上の氏名 `created_by_name`）・`version`（楽観ロック）・`archived_at`（論理削除） |

写真本体は R2（既存バケット `dub-file-attachments`、キー `sponsor/cards/<cardId>`、バインディング `SPONSOR_FILES`）。
1 名刺 1 枚で、撮り直しは上書き。削除時は R2 からも消す（best-effort）。

### 実装場所の判断（新サービスではなく member-service を拡張）

- 人事アプリと同じ理由: api-gateway は `members` セグメントを丸ごと member-service に流すので、ゲートウェイ・
  新しい Worker・D1 の追加が不要（$0 運用を崩さない）。登録者名も同じ D1 の名簿から引ける。
- コードは `src/sponsor-repo.ts` / `src/sponsor-service.ts` に分け、名簿のコードは太らせない。スポンサー管理が
  育って独立させるときは、この 2 ファイルとテーブル・R2 プレフィックスを移すだけで済む。

## 権限（ロール管理）

| キー | 意味 | 既定 |
|---|---|---|
| `app:sponsor:view` / `app:sponsor:edit` | スポンサーアプリの 無効/閲覧/編集（ロール管理の 3 段階） | admin のみ |
| `sponsor:read` | 共有された名刺の閲覧（個人情報） | admin のみ |
| `sponsor:write` | 名刺の登録（撮影）・連絡先/メモの編集・撮り直し | admin のみ |
| `sponsor:admin` ⚠ | 名刺の削除 | admin のみ |

- `APP_MANIFEST` に `sponsor`（domain `sponsor`）を登録 → ロール管理の行と「詳細設定」に自動で出る。
- `identity/0027_sponsor_app_perms.sql` で `role_sys_admin` にだけ付与。**スポンサーチームの自動ロール**
  （名簿の所属チームから付く `チーム: スポンサー` 等）にはロール管理から `編集` + `sponsor:read`/`sponsor:write` をオンにする。
- 表（`services/member-service/src/policy-table.ts`）: 読み取り = `appLevel("sponsor", "view", "sponsor:read")`、
  登録・編集・写真 = `appLevel("sponsor", "edit", "sponsor:write")`、削除 = `appLevel("sponsor", "edit", "sponsor:admin")`。

## API

すべて `/api/v1/members/sponsor/*`（gateway → member-service `/members/sponsor/*`）。型は `@dub/types` の `sponsor`。

| メソッド/パス | 内容 |
|---|---|
| `GET /members/sponsor/cards` | 一覧（論理削除を除く・更新日の新しい順） |
| `POST /members/sponsor/cards` | 登録（テキストはすべて任意） |
| `GET /members/sponsor/cards/:id` | 1 件 |
| `PATCH /members/sponsor/cards/:id` | 項目の更新（`expectedVersion` 必須・409） |
| `DELETE /members/sponsor/cards/:id` | 論理削除（写真も削除） |
| `PUT /members/sponsor/cards/:id/image` | 写真の保存/撮り直し（生のバイト列・jpeg/png/webp・3MB まで） |
| `GET /members/sponsor/cards/:id/image` | 写真の取得 |

登録は `POST` → `PUT image` の 2 段。写真だけ失敗したら名刺は残り、画面から再送できる。

## フロントエンド

`apps/fe2-app-shell/src/features/sponsor/`（人事・LP管理 と同じ FE2 ローカル feature）。

- `/sponsor` 名刺一覧（検索・サムネつきのカード）、`/sponsor/scan` 撮影 → 入力 → 保存。
- ランチャー・ホームに「スポンサー」。`releaseGate.PUBLISHED_APPS` には入れていないので admin 以外はグレー表示。
- demo（`VITE_DEMO=1`）: `lib/demo-seed.tsx` に名刺 store（写真あり/なし/未入力の seed）。撮影した写真も demo 上で一覧に出る。

## リリース手順と migration

1. demo で確認 → staging で実 backend（D1・R2 往復）を確認 → 本番デプロイ（admin のみ利用可）→
   スポンサーチームのロールに権限を付与 → メンバー公開（`PUBLISHED_APPS` に `sponsor` を足す 1 行）。
2. **本番デプロイ前に D1 migration を適用する**（前方のみ・additive）:
   - `infra/d1/migrations/member/0019_sponsor_cards.sql`（新規テーブル）
   - `infra/d1/migrations/identity/0027_sponsor_app_perms.sql`（admin への 5 キー付与）

## フェーズ2 以降の TODO

- 名刺の文字の自動読み取り（OCR）で項目を下書き入力する（無料で使える方式を検証してから決める）。
- 企業（スポンサー候補）単位のまとめ・協賛ステータス管理、名刺を企業に紐付け。
- 新しい名刺が共有されたらチームに通知。
- vCard 書き出し / 連絡先への追加。
