# スポンサーアプリ（スポンサーチーム向け）設計

## 目次

- [目的とスコープ](#目的とスコープ)
- [使い方の流れ](#使い方の流れ)
- [データモデル](#データモデル)
- [権限（ロール管理）](#権限ロール管理)
- [API](#api)
- [フロントエンド](#フロントエンド)
- [名刺の文字の自動読み取り（OCR）](#名刺の文字の自動読み取りocr)
- [営業進捗](#営業進捗)
- [月間目標](#月間目標)
- [リリース手順と migration](#リリース手順と-migration)
- [フェーズ2 以降の TODO](#フェーズ2-以降の-todo)

## 目的とスコープ

スポンサーチームが展示会・企業訪問などで受け取った名刺を、その場でスマホのカメラで撮って登録し、
チームの全員がすぐ見られるようにする。名刺がメンバー個人の手元に眠り、誰がどの企業と接点を持っているか
分からなくなるのを防ぐ。

フェーズ1（この PR）: 名刺の撮影（カメラ / 写真を選ぶ）・連絡先とメモの登録・名簿形式の一覧/検索・企業ごとのまとめ・詳細（編集・撮り直し・削除）・
ランチャー/ロール管理への登録・demo。

フェーズ2: **名刺の文字の自動読み取り（OCR）**。撮った写真から会社名・氏名・部署・役職・メール・電話を読み取り、
空いている項目に下書きとして入れる（[詳細](#名刺の文字の自動読み取りocr)）。写真だけでも登録でき、項目はすべて任意のまま。

## 使い方の流れ

1. `/sponsor` の「名刺をスキャン」→ カメラの映像に名刺の枠（91:55）が出る → シャッター → 「この写真を使う」。
   カメラが使えない端末（PC・権限拒否）は「写真を選ぶ」で撮影済みの写真を使う。
2. 写真の文字が自動で読み取られ、空欄に入る（数秒・初回は準備に少し時間がかかる）。写真と見比べて直し、
   メモ（どこで交換したか・協賛の温度感など）を足して保存（すべて任意）。
3. 権限のあるメンバー全員の一覧に出る。詳細からメール / 電話へ直接つなげる。

写真は端末側で長辺 1600px の JPEG に縮小してから送る（通信量と保存量を抑える）。

## データモデル

D1 `member` namespace のテーブル（いずれも additive）。

| テーブル | 役割 |
|---|---|
| `member_sponsor_cards` | 名刺。会社名・氏名・部署・役職・メール・電話・メモ・写真の形式（`image_content_type`、NULL = 写真なし）・登録者（`created_by` と登録時点の名簿上の氏名 `created_by_name`）・`version`（楽観ロック）・`archived_at`（論理削除） |
| `member_sponsor_leads` | 営業先（スプレッドシートの 1 行 = 1 社）。`infra/d1/migrations/member/0021_sponsor_leads.sql`。[営業進捗](#営業進捗)を参照 |
| `member_sponsor_goals` | 月間目標（1 か月 1 行）。`infra/d1/migrations/member/0022_sponsor_goals.sql`。[月間目標](#月間目標)を参照 |

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
| `sponsor:read` | 共有された名刺・営業進捗の閲覧（個人情報） | admin のみ |
| `sponsor:write` | 名刺の登録（撮影）・連絡先/メモの編集・撮り直し、営業進捗の追加・編集・取り込み | admin のみ |
| `sponsor:admin` ⚠ | 名刺・営業進捗の削除 | admin のみ |

- `APP_MANIFEST` に `sponsor`（domain `sponsor`）を登録 → ロール管理の行と「詳細設定」に自動で出る。
- `identity/0029_sponsor_app_perms.sql` で `role_sys_admin` にだけ付与。**スポンサーチームの自動ロール**
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

- `/sponsor` 名刺（名簿形式の表）: 写真・会社・氏名・部署/役職・登録者・登録日時（既定は新しい順・会社/氏名/登録者/日時で並べ替え・
  メール/電話列は「表示列」でオン）。会社名・氏名・部署・メモ・登録者で検索。行を押すと詳細ドロワー。
- `/sponsor/companies` 企業: 名刺を会社名でまとめた表（名刺の枚数・先方の担当者・接点のあるメンバー・最終登録日）。行を押すと
  その企業の名刺（誰がいつ登録したか）→ 名刺の詳細。
- `/sponsor/scan` 撮影 → 入力 → 保存。
- 部品は共通コンポーネントで組む（人事・応募者と同じ形）: 絞り込み = `FilterBar` + `FilterChips`（名刺は登録者・企業は接点のあるメンバー）、
  検索 = `@dub/app-ui` `useClientFilter`、表 = `DataTable`、0 件/条件に合わない = `EmptyState`、状態表示 = `Badge`、
  下書きの復元 = `DraftRestoredNotice`、エラー = `FormError`、ボタン行 = `DialogActions`。

### 企業の紐付け（企業テーブルは持たない）

- 企業 = 名刺の `companyName` を照合キー（NFKC・小文字・法人格「株式会社」「(株)」等・空白/記号を除く）でまとめたもの
  （`features/sponsor/companies.ts`）。表示名はいちばん多い表記（同数なら新しい名刺の表記）。
- 入力時、会社名の下に「登録済みの企業」候補を出し、押すとその表記に揃える（別表記での分裂を防ぐ）。
- 協賛ステータスなど企業そのものの情報は `member_sponsor_leads` に持つ（名刺とは外部キーなしで、この照合キーで結ぶ）。
- ランチャー・ホームに「スポンサー」。`releaseGate.PUBLISHED_APPS` には入れていないので admin 以外はグレー表示。
- demo（`VITE_DEMO=1`）: `lib/demo-seed.tsx` に名刺 store（写真あり/なし/未入力の seed）。撮影した写真も demo 上で一覧に出る。

## 名刺の文字の自動読み取り（OCR）

- **方式 = 端末内 OCR（[Tesseract.js](https://github.com/naptha/tesseract.js)・日本語 + 英語）**。ブラウザの Web Worker で
  動くので、写真（個人情報）を外部の AI/API に送らない・従量課金が発生しない（$0）。backend・D1・権限の変更なし。
  - エンジン（wasm）と学習データ（jpn/eng）は初回だけ jsDelivr CDN から取得し、以後はブラウザにキャッシュされる。
  - ライブラリは読み取る瞬間に動的 import する（一覧などほかの画面のバンドルは増えない）。
  - 見送った案: Cloudflare Workers AI の画像モデル（精度は高いが、写真を外部推論に送る・無料枠超過で課金/失敗の恐れ・
    demo（mock）で確認できない）。精度が足りなくなったら再検討する。
- **流れ**（`features/sponsor/SponsorScanScreen.tsx`）: 撮影 or 写真を選ぶ → 「この写真を使う」で自動で読み取り開始
  （進捗 %・「読み取りをやめる」）→ 終わったら **空いている項目にだけ** 入れる（読み取り中に手で入れた値は上書きしない。撮り直したときは、前回自動で入れたまま手を加えていない項目を新しい結果で置き換える）→
  「N 項目に入力しました。写真と見比べて確認してください」。読めなかったら「もう一度読み取る」。
  失敗時の下書き復元から開いたときは自動では読まず、「写真から読み取る」で手動実行。
- **項目への振り分け**（`features/sponsor/parseCardText.ts`・純関数でテスト済み）: OCR テキストを行ごとに正規化
  （全角→半角・日本語の文字間に入る空白を詰める）し、メール（正規表現）/ 電話（FAX は除外・携帯優先）/
  会社（法人格・大学・Inc. 等）/ 部署・役職（「営業部部長」「開発本部 シニアエンジニア」も分割）/ 氏名（残った短い漢字・かなの行を優先、
  無ければローマ字）を推定する。住所・URL は無視。
- **認識設定**: tesseract.js の既定（1 ブロック扱い）は文字サイズが混在する名刺で大きい氏名を落とすため、
  ページ分割を自動解析（`PSM.AUTO`）にしている。
- 限界: 縦書き・装飾フォント・暗い/斜めの写真は読めないことがある。その場合も手入力で登録できる（あくまで下書き）。

## 営業進捗

何社に声をかけて、どこまで進んだかをチームで管理する。これまでスプレッドシート（`02_営業管理`）で管理していた表を
そのままアプリに移したもの。

- **画面**: `/sponsor/leads`（「営業」タブ）。`features/sponsor/SponsorLeadsScreen.tsx`。上に集計 4 つ、下に表。
  - 集計はスプレッドシートの「現在の営業状況」と同じ数え方（`leads.ts` の `summarizeLeads`）: 登録企業数 / 接触済 = 未接触以外（見送りも含む）/
    提案済 = 提案済以降 / 内諾・契約 = 内諾 + 契約済。
  - 既定で見える列は 企業名・ステータス・優先度・営業担当・検討プラン・最終接触日・次回アクション・次回アクション日。残りは「表示列」でオンにする。
    既定の並びは進んでいる順（見送りは最後）。
  - ステータスは表の中で変えられる。ほかの項目は行を押して開く詳細から編集する。会社名の照合キーが同じ名刺があれば、詳細に出てそのまま開ける。
  - 次回アクション日を過ぎた行には「期限切れ」（契約済・見送りを除く）。
- **項目**: スプレッドシートの列と 1 対 1（`No.` だけは行番号なので持たない）。選択肢の値はスプレッドシートの表記そのままで、SoT は `@dub/types` `sponsor`。
  - 業界・接点区分は実データが選択肢に収まっていないので自由入力。担当者メールは「a／b（CC）」があるので形式を検査しない。
- **取り込み**: 「スプレッドシートから取り込む」にシートを見出しごと貼り付ける（`leadImport.ts`）。Excel / Google スプレッドシートのコピーはタブ区切りで届く。
  - 列は見出しの名前で読むので、順番が変わってもよい。読み取れない値は空にして、取り込む前に一覧で知らせる（「なし」「-」は空として扱う）。
    長すぎて保存できない値があるときは、どの企業のどの列かを出して取り込みを止める。
  - サーバは全行を検証してからまとめて登録する（1 行でも不正なら何も入らない）。照合キーが同じ企業は飛ばすので、貼り直しても重複しない（DB の一意制約は無いので、2 人が同時に取り込むと重複しうる）。1 回 500 社まで。
- **実データはリポジトリに入れない**: このリポジトリは公開なので、企業名・担当者・メールを migration や seed に書かない。demo も認証なしの公開 URL なので架空の企業のみ。
- **初期データの投入**: `apps/fe2-app-shell/scripts/sponsor-leads-seed.ts` が手元の Excel から SQL を作る（入力も出力もリポジトリの外）。
  migration の適用後に、staging → 本番の順で適用する。同じ企業名の行があれば（削除済みでも）入れないので再実行してよい。
  照合は企業名の完全一致なので、画面から登録を始める前に投入する（表記違いは別の企業として入る）。

  ```sh
  pnpm -C infra/d1 exec tsx "$PWD/apps/fe2-app-shell/scripts/sponsor-leads-seed.ts" ~/Downloads/営業進捗管理.xlsm /tmp/sponsor-leads-seed.sql
  wrangler d1 execute <dub-core-staging2 など> --remote --file /tmp/sponsor-leads-seed.sql
  rm /tmp/sponsor-leads-seed.sql
  ```
- **API**（`/members/sponsor/leads`）: `GET` 一覧 / `POST` 追加 / `POST /import` 取り込み / `GET /:id` / `PATCH /:id`（`expectedVersion` 必須・409）/ `DELETE /:id`（論理削除）。
- **権限**: 名刺と同じ。閲覧 = `sponsor:read`、追加・編集・取り込み = `sponsor:write`、削除 = `sponsor:admin`。

## 月間目標

月ごとの目標に対する達成率を見る。`/sponsor/goals`（「目標」タブ）。`features/sponsor/SponsorGoalsScreen.tsx` / `goals.ts`。

- **指標は 4 つ**。実績は保存せず、営業進捗の日付から数える（`monthActuals`）。

  | 指標 | 数え方 |
  |---|---|
  | 新規接触（社） | 初回連絡日がその月 |
  | 提案（社） | 提案日がその月 |
  | 内諾・契約（社） | 内諾日がその月（見送りを除く） |
  | 協賛額（円） | その月に内諾した企業の想定協賛額の合計（見送りを除く） |

- **日付の記録**: ステータスが進むと、初回連絡日・提案日・内諾日を日本時間の今日で自動で埋める（`sponsor.applyLeadMilestones`）。既に日付があれば残し、手前へ戻すと消す。見送りにする時は残し、見送りから戻す時は戻した先より後の日付を消す。詳細から手で直せる。
  取り込みと初期データでは埋めない（過去の日付は分からないため）。達した節目の日付が空の企業はその分が月の実績に入らず、画面に社数を出す。
- **目標**: 指標ごとに任意（空欄は目標なしで、達成率を出さない）。保存は `PUT /members/sponsor/goals/:month`（`expectedVersion`、新規は 0・409）。閲覧 = `sponsor:read`、設定 = `sponsor:write`。
- **目標管理アプリと連動**: ここで置いた目標値は、目標管理のスポンサー 4 指標の KPI の目標値になる（[詳細](goals-app.md#スポンサーの目標タブとの連動)）。
- 達成率は切り捨てで、100% を超えても数値はそのまま出し、メーターは 100% で止める。月の区切りは日本時間。

## リリース手順と migration

1. demo で確認 → staging で実 backend（D1・R2 往復）を確認 → 本番デプロイ（admin のみ利用可）→
   スポンサーチームのロールに権限を付与 → メンバー公開（`PUBLISHED_APPS` に `sponsor` を足す 1 行）。
2. **本番デプロイ前に D1 migration を適用する**（前方のみ・additive）:
   - `infra/d1/migrations/member/0020_sponsor_cards.sql`（新規テーブル）
   - `infra/d1/migrations/member/0021_sponsor_leads.sql`（新規テーブル）
   - `infra/d1/migrations/member/0022_sponsor_goals.sql`（新規テーブル）
   - `infra/d1/migrations/identity/0029_sponsor_app_perms.sql`（admin への 5 キー付与）

## フェーズ2 以降の TODO

- 名刺から営業先を 1 回で追加する導線（今は「企業を追加」で手入力）。
- 新しい名刺が共有されたらチームに通知。
- vCard 書き出し / 連絡先への追加。
