# 人事アプリ（面談 → 採用 → オンボーディング）設計

## 目次

- [目的とスコープ](#目的とスコープ)
- [ステータス](#ステータス)
- [データモデル](#データモデル)
- [名簿・参加届とのつながり](#名簿参加届とのつながり)
- [権限（ロール管理）](#権限ロール管理)
- [API](#api)
- [フロントエンド](#フロントエンド)
- [面談申し込みフォーム](#面談申し込みフォーム)
- [面談の日程調整](#面談の日程調整)
- [リリース手順と migration](#リリース手順と-migration)
- [フェーズ2 以降の TODO](#フェーズ2-以降の-todo)

## 目的とスコープ

応募してきた人の面談日程の調整から、面談・採用（または不採用/辞退）を経て、運営メンバー・名簿への追加と
**オンボーディング**（最初にやってほしいことの完了）までを、1 枚の表で追えるようにする。

フェーズ1（この PR）: 応募者の表（絞り込み・並べ替え・検索・その場でステータス変更）・面談日・メモ/履歴・
採用（確認 → 名簿に追加）・オンボーディングのチェックリスト（ステータス自動更新）・ランチャー/ロール管理への登録・demo。

## ステータス

人事の運用に合わせた 8 つ（この順で表示）:

| キー | 表示 | 名簿 |
|---|---|---|
| `scheduling` | 面談日程調整中 | — |
| `interview_set` | 面談確定 | — |
| `interviewed` | 面談済み | — |
| `hired` | 採用 | 在籍として追加済み |
| `rejected` | 不採用 | — |
| `onboarding` | オンボーディング調整 | 在籍 |
| `onboarded` | オンボーディング完了 | 在籍 |
| `withdrawn` | 辞退 | — |

### 遷移の規則（SoT: `@dub/types` の `hr.canTransition` / `hr.requiresJoin`）

- **寛容**: 人事が誤操作を直せるよう、前のステータスへ戻すことも含めて **どこからどこへでも** 動かせる（同じステータスへの移動だけ不可）。辞退はどこからでも。
- **例外は 1 つだけ**: `採用` / `オンボーディング調整` / `オンボーディング完了`（名簿前提のステータス = `hr.ROSTER_STAGES`）は、**名簿に結ばれている人だけ**。
  まだ名簿にいない人をそこへ動かすのは `POST /join`（採用）専用で、画面では **確認ダイアログ → 名簿に追加** を必ず通す（黙って追加しない）。`/stage` で送ると 409 `HR_JOIN_REQUIRED`。
  確認ダイアログで「オンボーディング調整/完了」を選んでいた場合は、採用のあと続けてそのステータスにする。
- 一度名簿に入った人は、その後 採用 ⇄ 不採用 ⇄ オンボーディング… も普通のステータス変更（名簿の行は名簿側で管理し、二重追加しない）。
- **オンボーディング完了の自動更新**: オンボーディングのチェックを付けると、1 つ以上で `採用 → オンボーディング調整`、全部で `→ オンボーディング完了`、完了から外すと `→ オンボーディング調整` に自動で動く（履歴に「オンボーディングのチェックで自動更新」）。オンボーディング完了は表のプルダウンから手動でも選べる。

```mermaid
stateDiagram-v2
  [*] --> scheduling: 面談申し込みフォーム (本人 / 代わりに入力)
  scheduling --> interview_set
  interview_set --> interviewed
  interviewed --> hired: 確認ダイアログ → 名簿に追加 (POST /join)
  interviewed --> rejected
  hired --> onboarding: チェックを1つ以上 (自動) / 手動
  onboarding --> onboarded: 全部チェック (自動) / 手動
  note right of scheduling: どこからでも 辞退・前のステータスへ戻すのも可
```

### 絞り込み（表の上のチップ・件数つき）

| チップ | 条件 |
|---|---|
| すべて | 全員（論理削除を除く） |
| オンボーディング前 | `採用` + `オンボーディング調整`（= 採用済みでオンボーディングが終わっていない人。`hr.BEFORE_ONBOARDING_STAGES`） |
| 各ステータス | そのステータスの人 |

## データモデル

D1 `member` namespace に新規テーブル 3 つ（`infra/d1/migrations/member/0017_hr.sql`、additive）。

| テーブル | 役割 |
|---|---|
| `member_hr_applicants` | 応募者。氏名・連絡先・学科/学年・希望チーム・応募経路・志望動機・面談日 (`interview_at`)・ステータス (`stage`)・`member_id`（参加後の名簿行）・`participation_id`（元の参加届・任意）・`version`（楽観ロック）・`archived_at`（論理削除） |
| `member_hr_events` | 履歴（追記のみ）。`created` / `stage`（from→to + 理由）/ `note` / `joined`（採用）。表の「メモ」列は本文のある最新の履歴 (`latestNote`) |
| `member_hr_onboarding_checks` | オンボーディングのチェック状態（`person_id` × `item_id`）。項目そのものは持たない |

## 名簿・参加届とのつながり

**名簿（`member_people`）を複製しない** のが原則。

- **採用**（`POST /members/hr/applicants/:id/join`、名簿にまだいない人なら どのステータスからでも）
  - `memberId` 省略: 応募内容から在籍（`added`）の名簿行を作る。作成は既存の `MemberService.createMember` をそのまま使う（名簿の検証・採番・並び順のロジックを二重に持たない）。希望チームがあればそのチームに所属。
  - `memberId` 指定: 既存の名簿行に結ぶ（招待中/検討中なら在籍に上げる）。打診済みの人が応募フォームからも来たケース用。
- **オンボーディング**: 対象は名簿前提のステータス（採用 / オンボーディング調整 / オンボーディング完了）の人。項目は参加届アプリの「オンボーディング案内」（`member_onboarding_items`、公開ページ `/onboarding` と同じもの）をテンプレートとしてそのまま使う。人事側はチェック状態だけを持つので、案内を編集すればチェックリストにも反映される。
- **参加届**: 公開フォーム `/participate` の 参加届 は従来どおり名簿反映フロー（参加届アプリ）。応募者の詳細から入力済みの参加届リンクを作れる（[面談申し込みフォーム](#面談申し込みフォーム)）。`participation_id` で参加届と結ぶ取り込みはフェーズ2。

### 実装場所の判断（新サービスではなく member-service を拡張）

- 採用は名簿行の作成と同じトランザクション境界（同じ D1・同じ Worker）にあるべきで、別サービスにすると Service Binding 越しの 2 段書き込みと失敗時の補償が要る。
- オンボーディング項目・チーム・名簿をすべて同じ namespace から読める。
- api-gateway は `members` セグメントを丸ごと member-service に流しているので、ゲートウェイ・wrangler・D1 バインディングの追加が不要（$0 運用を崩さない）。
- 人事のコードは `src/hr-repo.ts` / `src/hr-service.ts` に分け、`MemberRepo` / `MemberService` は太らせない。将来切り出すときはこの 2 ファイルとテーブルを移すだけで済む。

## 権限（ロール管理）

| キー | 意味 | 既定 |
|---|---|---|
| `app:hr:view` / `app:hr:edit` | 人事アプリの 無効/閲覧/編集（ロール管理の 3 段階） | admin のみ |
| `hr:read` | 応募者・履歴・オンボーディング進捗の閲覧（個人情報） | admin のみ |
| `hr:write` | 応募者登録・ステータス変更・面談日・メモ・オンボーディングのチェック | admin のみ |
| `hr:admin` ⚠ | 採用（名簿への追加）・応募の削除 | admin のみ |

- `APP_MANIFEST` に `hr`（domain `hr`、`detailPermissions: [hr:read, hr:write, hr:admin]`）を登録 → ロール管理の行と「詳細設定」に自動で出る。
- `identity/0025_hr_app_perms.sql` で `role_sys_admin` にだけ付与。他ロールはロール管理で明示的にオン。
- 表（`services/member-service/src/policy-table.ts`）:
  - 読み取り = `appLevel("hr", "view", "hr:read")`
  - 登録・更新・ステータス・メモ・チェック = `appLevel("hr", "edit", "hr:write")`
  - 採用・削除 = `appLevel("hr", "edit", "hr:admin")`（画面でも hr:admin が無いと採用系の選択肢は押せない）
  - 人事アプリが無効なら詳細キーだけでは何も触れない（ロール行列テストで固定）。

## API

すべて `/api/v1/members/hr/*`（gateway → member-service `/members/hr/*`）。型は `@dub/types` の `hr`。

| メソッド/パス | 内容 |
|---|---|
| `GET /members/hr/applicants` | 一覧（論理削除を除く・`latestNote` つき） |
| `POST /members/hr/applicants` | 登録（`面談日程調整中` + 履歴 `created`） |
| `GET /members/hr/applicants/:id` | 詳細 + 履歴 |
| `PATCH /members/hr/applicants/:id` | 項目・面談日の更新（`expectedVersion` 必須・409） |
| `DELETE /members/hr/applicants/:id` | 論理削除（`archived_at`・`hr:admin`）。履歴 `deleted` を追記し、履歴とフォーム回答は残す。採用〜オンボーディング完了（`hr.blocksRemoval`）の人は 409 `HR_APPLICANT_JOINED`。採用後に辞退などへ動かした人は削除でき、名簿の行は残す |
| `POST /members/hr/applicants/:id/stage` | ステータス変更（名簿にいない人の採用系は 409 `HR_JOIN_REQUIRED`） |
| `POST /members/hr/applicants/:id/notes` | メモ追加 |
| `POST /members/hr/applicants/:id/join` | 採用（名簿へ追加。既に名簿にいれば 409） |
| `GET /members/hr/onboarding` | 採用済みの人ごとの進捗 + 項目 |
| `PUT /members/hr/onboarding/:memberId/items/:itemId` | チェックのオン/オフ（ステータス自動更新） |

## フロントエンド

`apps/fe2-app-shell/src/features/hr/`（LP管理 と同じ FE2 ローカル feature）。

- `/hr` 応募者（表）: 1 人 1 行。列 = 氏名 / 学科・学年 / 希望チーム / ステータス / 面談日 / 更新日 / メモ。
  列見出しで並べ替え（既定は更新日の新しい順）、氏名・フリガナ・学科で検索、上のチップで絞り込み（件数つき）。
  ステータスは行のプルダウンでその場で変更（楽観的 UI・失敗で戻る）。名簿にいない人の採用系は確認ダイアログ。行を押すと詳細ドロワー。
- 詳細ドロワー: ステータス・面談日（日時入力・楽観的）・項目・メモ・履歴・削除（確認ダイアログ）。
- `/hr/onboarding`: 採用済みの人ごとのチェックリスト・進捗バー・ステータスバッジ（楽観的 UI）。
- 制御コンポーネント（チェックボックス・プルダウン）は「押した値」を同じ描画で重ねて表示する（`usePendingOverlay`）。
  以前はミューテーションの onMutate が走るまでの一瞬だけ古い値に戻って見えていた（チェックが一瞬外れる不具合）。
- 進捗バーの色は以前存在しないトークン（`--dub-color-brand-6`）を参照していて完了でも空に見えていた → `brand-500`（完了は `success-500`）に修正。
- 読み込み中はスケルトン、失敗は再試行つき ErrorState。閲覧者にはプルダウン/書き込みボタンを出さない（`useAppCapability("hr")` + `hr:write`/`hr:admin`）。
- ランチャー・ホームに「人事」。`releaseGate.PUBLISHED_APPS` には入れていないので admin 以外はグレー表示。
- demo（`VITE_DEMO=1`）: `lib/demo-seed.tsx` の名簿 demo の中に人事 store（全 8 ステータスに 1 人以上）。採用で demo 名簿に在籍が増え、チェックでステータスが自動で動く。

## 面談申し込みフォーム

参加届より前の面談に申し込んでもらう公開フォーム（Google フォーム風に人事アプリで質問を編集できる）。

- **既存フローへの乗り方**: 回答 = 応募者の登録。`HrService.create` をそのまま通すので、応募者は **面談日程調整中** で入り、以降のステータス変更・採用（名簿へ）は手で登録した人と同じ。応募経路は「面談申し込みフォーム」（代理入力は「…（代理入力）」）。
- **質問と応募者の列**: 質問に「応募者の項目」（苗字・名前・ふりがな（せい/めい）・メール・学科・学年・志望動機）を選ぶと、その回答が応募者の列に入る（姓名は応募者の 1 列に合成）。**苗字・名前・メールの質問は必須で消せない**。それ以外の回答は JSON として応募者に結び、詳細ドロワーに表示する。回答時点の質問も保存するので、あとで編集しても過去の回答は崩れない。
- **参加届と同じ形**: 姓/名・ふりがな（せい/めい）は 2 欄、学年は参加届の選択肢（`member.GRADE_LABEL`）に揃える。保存済みの旧フォーム（氏名 1 欄・「専攻科」など）は `hrForm.upgradeQuestions` が読むたび・保存のたびに変換する（D1 の行は次の保存まで旧形式のまま・migration 不要）。
- **参加届への引き継ぎ**: 応募者の詳細の「参加届の入力済みリンクをコピー」で `/participate#prefill=<base64url JSON>` を作り、人事が本人に送る。内容は `hrForm.participationPrefill`（応募者の列 + 最新の回答）。メールは 1 欄なので `@gmail.com` なら Gmail、それ以外は学校メールに入る。
  - URL の fragment に載せるのでサーバーには送られない（公開 API・migration・トークン管理が不要）。参加届は読んだら fragment を消す。受け取った値は `member.parsePersonProfilePatch` を通し、不正な項目は捨てる。入力欄の初期値になるだけで、提出時の検証は通常どおり。
  - リンクに氏名・メールが含まれ失効はできないので、本人にだけ送る。
- **重複防止**: 同じメールで選考前（面談日程調整中 / 面談確定 / 面談済み）の応募者がいれば新しく作らず、その人に回答を足して履歴に残す。
- **受付の開閉**: 受付停止中は公開ページが「受付終了」を表示し送信は 409。人事の代理入力は停止中でも可。
- **契約 / 検証の SoT**: `@dub/types` の `hrForm`（`validateFormDefinition` / `validateAnswers` をフロントとサービスで共有）。
- **API**: `GET|PUT /members/hr/interview-form`（閲覧+hr:read / 編集+hr:write）・`GET|POST /members/hr/interview-form/responses`（一覧 / 代理入力）・公開は gateway `GET|POST /api/v1/public/hr-interview-form`（PUBLIC → member-service `/members/internal/hr/interview-form` INTERNAL）。bot 対策は囮フィールド + Turnstile（token があるとき）+ IP レート制限。
- **画面**: 人事 → 申し込みフォーム タブ（公開 URL・編集・回答一覧・代わりに入力する）、公開ページ `/interview-apply`（シェルの外・ログイン不要）。
- **応募者の登録口はこのフォームに一本化**: 旧「応募者を登録」ボタン/ダイアログは廃止。応募者タブの見出し（と空の状態）には「面談申し込みを代わりに入力」を置き、申し込みフォーム タブの代理入力を開いた状態（`/hr/form?enter=1`）へ移る。バックエンドの作成処理（`HrService.create`。フォームの受付がこれを通す）と `POST /members/hr/applicants` はそのまま残す。
- **migration**: `infra/d1/migrations/member/0019_hr_interview_form.sql`（新規 2 テーブルのみの additive）。

## 面談の日程調整

申し込みの時点では日程を聞かず、案内メールの URL から人事が登録した候補を選んでもらう。人事の候補登録が終わる前に申し込みが来ても、候補が揃うまでメールを保留できる。

1. 面談申し込みフォームへ回答 → 応募者（面談日程調整中）+ 招待（`member_hr_interview_invites`）を作る。代理入力でも同じ。
2. 選べる候補が設定数以上なら、申し込みのお礼と日程選択 URL のメールをすぐ送る。足りなければ招待を保留する。
3. 応募者が `/interview-book#t=<token>` で日時を選ぶ → 枠が埋まり、応募者は **面談確定** に動き、面談日が入る。確認メールと、担当者への in-app 通知が出る。

- **候補の数え方**: 未来の空き枠を、同じ開始・終了ごとに 1 候補と数える（2 人が同じ時間に空いていても応募者には 1 行）。応募者に担当者は見せない。
- **保留の解除**: 枠の追加・設定の変更・次の申し込みのたびに見直す。無料枠の Cron（アカウントで 5 本）は埋まっているので定期実行は足さない。送信に失敗した招待も保留のまま次の契機に送る。人事は面談タブの「今すぐ送る」で候補数に関係なく送れる。
- **送信の上限**: 1 回 20 通、24 時間で 30 通。公開フォームは任意の宛先へメールを送らせられるので、mail-gateway の Resend 無料枠（100 通/日）を保護する。超えた分は保留に残る。
- **送らない人**: 保留の間に辞退などで面談日程調整中でなくなった人。再回答（同じメールの重複）では再送しない。
- **同時押し**: `bookSlot` の `UPDATE ... WHERE applicant_id IS NULL` と部分 UNIQUE（1 人 1 枠）で 1 人に絞る。負けた人には 409 `HR_SLOT_TAKEN` を返し、最新の候補を出し直す。
- **予約の取り消し**: 予約のある枠は削除できない。面談タブの「予約を取り消す」で空きに戻し、応募者を面談日程調整中へ戻す。同じ URL で選び直せる。本人への連絡は人事が行う。
- **トークン**: 32 バイトの乱数。漏れても面談を 1 件予約できるだけなので、再送で同じ URL を使えるよう平文で持つ（メール本文は mail-gateway の送信ログとアーカイブ CC にも残る）。人事の API にも返さない。URL の fragment に載せ、公開 API は body で受ける。
- **メール**: mail-gateway の `POST /send`（Service Binding `SVC_MAIL_GATEWAY`）。`x-dub-user-id` があると本人の `mail:send` を要求されるので、ユーザー無しのシステム送信で呼ぶ。宛先の URL は `APP_BASE_URL`。どちらかが無い環境ではメールは保留のまま。
- **API**: `GET /members/hr/interviews`（閲覧 + hr:read）・`PUT .../settings`・`POST .../slots`・`DELETE .../slots/:id`・`POST .../slots/:id/release`・`POST .../invites/:id/send`（編集 + hr:write）・公開は gateway `POST /api/v1/public/hr-interview-booking/{view,book}`（PUBLIC → member-service `/members/internal/hr/interview-booking/*` INTERNAL）。契約の SoT は `@dub/types` の `hrInterview`。
- **画面**: 人事 → 面談 タブ（`/hr/interviews`）。候補数と保留の状況・送り始める候補数の設定・日程の登録・案内の一覧。
- **demo**: メールは送らない。公開ページは `/interview-book#t=demo`。
- **未対応**: 応募者自身による日程変更（確認メールに返信してもらい、人事が取り消す）、面談の場所・URL の案内、Google カレンダー連携、保留が続いたときの人事への通知。
- **migration**: `infra/d1/migrations/member/0024_hr_interviews.sql`（新規 3 テーブルのみの additive）。

## リリース手順と migration

1. demo で確認 → 本番デプロイ（admin のみ利用可）→ メンバー公開（`PUBLISHED_APPS` に `hr` を足す 1 行）。
2. **本番デプロイ前に D1 migration を適用する**（前方のみ・additive）:
   - `infra/d1/migrations/member/0017_hr.sql`（新規テーブル 3 つ）
   - `infra/d1/migrations/identity/0025_hr_app_perms.sql`（admin への 5 キー付与）
   - `infra/d1/migrations/member/0024_hr_interviews.sql`（面談の日程調整の新規テーブル 3 つ）

## フェーズ2 以降の TODO

- 公開応募フォーム（未ログインで応募 → `面談日程調整中` で登録。Turnstile・レート制限は参加届と同じ gateway 経路）。
- 参加届 → 応募者の取り込み（`participation_id` で紐付け）、または応募者 → 参加届フォームの案内メール送信。
- 面談のカレンダー/ミーティング連携、評価欄。
- ステータス変更時の通知（担当者・本人へのメール）とメールテンプレート。
- 採用時のアカウント発行（参加届アプリの「メール発行 + 招待」フローを再利用）。
- オンボーディング: 人事経由でない名簿メンバーも対象に（期間指定）、担当者・期限、全員完了の通知。
- 応募者の検索・CSV 出力、応募経路別の集計。
- 個人情報の保持期間（不採用/辞退の一定期間後の削除）。
- 名簿側（運営メンバー詳細）から人事履歴へのリンク。
- 実ブラウザ E2E を `apps/fe2-app-shell/e2e/` に spec 化（今回は手動 Playwright で検証）。
