# policy-gate 全 API 棚卸し (22 サービス)

> 作成: 2026-10-01 / branch `feat/policy-gate-all-apis` (base `origin/main`)
> 目的: 全サービスの API を `@dub/policy-gate` の宣言的認可テーブルに載せるための設計図。
> **この表の基準コミットは `fb811d04`**(= policy-gate 土台 + drive-share-service 採用済みの状態)。
> 「現在の認可」「提案ルール」の全記述はこのコミットのツリーを基準に読むこと。
> 本書自体は調査結果のドキュメントであり、本書の作成ではコードを変更していない。

## 結論

**全 22 サービス・約 310 ルートを棚卸しした。移行はほぼ機械的だが、先に潰すべき実在の穴が 5 件ある。**

理由:

1. `@dub/policy-gate` パッケージ自体は **完成した状態で存在する**(commit `fb811d04`)。
   `rule.ts` / `table.ts` / `gate.ts` / `routes.ts` / `coverage.ts` / `authz.ts` が揃い、
   `tsconfig.base.json` のパス解決も通っている。**採用済みサービスは drive-share-service の 1 件**
   (参照実装)。`services/drive-share-service/src/policy-table.ts` が実在し、`src/app.ts:43` で
   `app.use("*", policyGate({...}))` を最初にマウント、`test/policy-table.test.ts` が
   `assertRouteCoverage` で表とルートの一致を検証、`package.json` に
   `@dub/policy-gate: workspace:*` が入っている。**残り 21 サービスが未採用**。
2. 既存の認可は 7 種類の方式に分裂している(`requireAuth` + `requirePermission` /
   `requireAppAccess` / `requireAny`(OR) / inline `x-dub-internal` / 共有シークレット /
   HMAC 署名 / 何も無し)。テーブル化の価値はここにある。
3. 現状は「意図的に公開」と「書き忘れ」がコード上区別できない。実際に
   **commander-service は GET 全 11 本が完全無認可**で、CORS `origin: "*"` が付いている。
   ただし commander-service は**現時点で本番にも staging にもデプロイされていない**(後述 2.22)
   ため、**現状の外部露出は無い**。リスクは「手動 deploy した瞬間に成立する」潜在リスクと
   ローカル dev での CORS 経由読み取りの 2 つ。
4. 一方で、大半のルートは既に `requirePermission("<key>")` が付いており、
   提案ルールへの変換は 1:1。危険なのは「既存が無い所」だけに集中している。

結論として、**実装順は「外部到達 × 認可が弱い」順**(gateway/auth → commander → mail/member →
残り)。先に語彙の穴(後述 `AUTHENTICATED` 不在・OR セマンティクス・共有シークレット)を塞ぐこと。

---

## 1. 前提 — 語彙と判定材料

### 1.1 ルール語彙 (`packages/policy-gate/src/rule.ts`)

| ルール | 意味 | ゲートの挙動 |
|---|---|---|
| `PUBLIC` | 無認証で誰でも叩いてよい | 素通し |
| `INTERNAL` | サービス間専用 | `x-dub-internal` が無ければ 403 |
| `[key, ...]` | 全キー必須 (AND) | `x-dub-user-id` 必須 + identity `/authz/check` |
| `appLevel(app, level, ...extra)` | 上記 `RequiredKeys` を生成する糖衣 | 同上 |
| テーブルに無い | — | **403 (fail-closed)** |

`appLevel` の展開は `policy.keysForAppLevel` に従う:
`appLevel("members","view")` -> `["app:members:view"]`、
`appLevel("mail","edit","mail:send")` -> `["app:mail:view","app:mail:edit","mail:send"]`。
**OR は意図的に存在しない**(`rule.ts` に明記)。

### 1.2 外部到達の判定根拠

- api-gateway の `ROUTES` にセグメントが有るか(`routes.ts`)。無いサービスは外部から到達しない。
- `internalOnlyPaths` に該当するとエッジで 404(二重防御)。指定があるのは
  identity / notifications / mail / audit / members **のみ**。
- `proxy.ts` が外部リクエストの `x-dub-*` を**全て剥離**し、`x-dub-internal` を再付与しない。
  よって `INTERNAL` は外部から詐称不能 = 境界として健全。
- `wrangler*.toml` の `workers_dev`。`true` の 4 サービスのうち chat / gantt / notification は
  `index.ts` で `url.hostname === "svc"` を検査して binding 経由以外を 404 にしている。
  **app-health-monitor だけこのガードが無い**(後述)。

---

## 2. サービス別 棚卸し表

### 2.1 api-gateway (自身が処理する所有ルート)

全ルートに `cors` -> `requestId` -> `rateLimit` が適用。`GATEWAY_OWNED_SEGMENTS` は
`routes.ts:23` に定義されているが**どこからも参照されていない**(登録順だけが所有の実体)。

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /healthz | ○ | なし | `PUBLIC` | 生存確認、version のみ返す |
| GET /api/v1/me | ○ | `authenticate()` | 認証のみ(ハンドラ残し) | セッション本人の identity を返す self-scoped |
| GET /api/v1/bff/home | ○ | `authenticate()` | 認証のみ(ハンドラ残し) | 本人向け集約、各上流が個別に認可 |
| POST /api/v1/public/inquiries | ○ | Turnstile(必須・fail-closed) + rate-limit | `PUBLIC` | 未認証の問い合わせ受付 |
| POST /api/v1/public/participation | ○ | **条件付き** Turnstile + rate-limit | `PUBLIC` | 参加届 landing。token 省略で検証回避可(要注意 a-2) |
| POST /api/v1/me/password | ○ | `authenticate()` + 生トークン転送 | 認証のみ(ハンドラ残し) | 対象 id をクライアントが指定できない |
| POST /api/v1/admin/users/:userId/password | ○ | `authenticate()` + inline `requireAdmin()` | `["identity:admin"]` | 他ユーザーの初期パスワード発行 |
| GET /api/v1/admin/users/:userId/password | ○ | 同上 | `["identity:admin"]` | 平文パスワード閲覧(最高機密) |
| GET /api/v1/me/profile | ○ | `authenticate()` | 認証のみ(ハンドラ残し) | セッション id で引くだけ |
| POST /api/v1/me/profile | ○ | `authenticate()` | 認証のみ(ハンドラ残し) | 書き込み先が `auth.userId` 固定 |
| GET /api/v1/me/participation | ○ | `authenticate()` | 認証のみ(ハンドラ残し) | 本人 id で member-service へ s2s |
| POST /api/v1/me/participation | ○ | `authenticate()` | 認証のみ(ハンドラ残し) | 対象は常にセッション本人 |

**要確認**: `/me` 系 7 本は「認証のみ・キー無し」。`RequiredKeys` は非空が型で強制されるため、
語彙上これを表現する手段が無い(`PUBLIC` では認証が外れる)。第 4 の形 `AUTHENTICATED` が要る。

### 2.2 auth-service

gateway で `auth="public"`(エッジでセッション不要)。`app.use` は一切なし。

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /health | ×(internal) | なし | `PUBLIC` | `health` セグメント未登録 |
| POST /auth/password/login | ○ | なし(roster allowlist + PBKDF2 + rate limit) | `PUBLIC` | セッション発行前の鶏卵問題 |
| POST /auth/password | ○ | inline セッション検証 | `PUBLIC` + ハンドラ残し | `x-dub-user-id` が来ないため鍵判定不可 |
| POST /internal/admin/users/:userId/password | ×(internal) | `requireInternal` + `identity:admin` | `INTERNAL` | `/auth/*` 外でエッジ到達不可 |
| GET /internal/admin/users/:userId/password | ×(internal) | `requireInternal` + `identity:admin` | `INTERNAL` | 平文パスワード閲覧 |
| POST /verify | ×(internal) | `requireInternal` | `INTERNAL` | gateway/MO3 専用のトークン検証 |
| POST /auth/refresh | ○ | なし(トークン自体が資格情報) | `PUBLIC` | セッション更新 |
| POST /auth/logout | ○ | なし | `PUBLIC` | 未認証でも無害 |
| POST /auth/test-login | ○ | `config.testLoginEnabled` フラグのみ | `PUBLIC` | **任意 userId のセッションを無資格発行**(要注意 a-3) |
| POST /auth/demo-login | ○(`DEMO_AUTOLOGIN=1` 時のみ登録) | なし | `PUBLIC` | staging 限定の条件付き登録 |
| POST /mobile/exchange | ×(internal) | `requireInternal` | `INTERNAL` | MO3 専用 |
| POST /internal/revoke-user | ×(internal) | `requireInternal` | `INTERNAL` | 失効伝播専用 |

**注**: `demo-login` は env により登録有無が変わる。`assertRouteCoverage` は
`app.routes` を見るため、カバレッジテストが env 依存で揺れる。手当てが必要。

### 2.3 identity-roster

`/identity/*` は `requireAuth`、内部は `requireInternal`。
`requireAdminEdit` = `requirePolicy("admin", Edit, "identity:admin")`。

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /health | ×(internal) | なし | `PUBLIC` | セグメント未登録 |
| GET /identity/orgs | ○ | `requireAuth` + `identity:read` | `["identity:read"]` | 組織一覧は名簿読取り相当 |
| GET /identity/users | ○ | `requireAuth` + `identity:read` | `["identity:read"]` | 担当者ピッカー等の横断読取り |
| GET /identity/users/:id | ○ | `requireAuth` + self-or-`identity:read` | `["identity:read"]` + self 例外はハンドラ残し | 自分の詳細は常に可 |
| POST /identity/users/invite | ○ | `requireAdminEdit` | `appLevel("admin","edit","identity:admin")` | 招待は管理アプリの編集 |
| POST /identity/users/sync-email-routing/preview | ○ | `requireAdminEdit` | `appLevel("admin","edit","identity:admin")` | 差分プレビューも管理面 |
| POST /identity/users/sync-email-routing | ○ | `requireAdminEdit` | `appLevel("admin","edit","identity:admin")` | 一括同期は破壊的書込み |
| PATCH /identity/users/:id | ○ | `requireAdminEdit` (+ LAST_ADMIN ガード) | `appLevel("admin","edit","identity:admin")` | 属性・状態の変更 |
| POST /identity/users/:id/offboard | ○ | `requireAdminEdit` (+ LAST_ADMIN) | `appLevel("admin","edit","identity:admin")` | 失効 + ロール剥奪 |
| GET /identity/roles | ○ | `requireAuth` + `identity:read` | `["identity:read"]` | ロール一覧の読取り |
| POST /identity/roles | ○ | `requireAdminEdit` | `appLevel("admin","edit","identity:admin")` | RBAC 定義の変更 |
| PATCH /identity/roles/:id | ○ | `requireAdminEdit` | `appLevel("admin","edit","identity:admin")` | 権限集合の書換え |
| DELETE /identity/roles/:id | ○ | `requireAdminEdit` | `appLevel("admin","edit","identity:admin")` | RBAC 破壊操作 |
| GET /identity/users/:id/roles | ○ | `requireAuth` + `identity:read` | `["identity:read"]` | 付与状況の参照(self 例外なし) |
| POST /identity/users/:id/roles | ○ | `requireAdminEdit` | `appLevel("admin","edit","identity:admin")` | 権限昇格経路 |
| DELETE /identity/users/:id/roles/:assignmentId | ○ | `requireAdminEdit` (+ LAST_ADMIN) | `appLevel("admin","edit","identity:admin")` | ロール剥奪 |
| GET /identity/permissions/catalog | ○ | `requireAuth` + `identity:read` | `["identity:read"]` | 静的カタログ |
| POST /users/provision | ×(internal) | `requireInternal` | `INTERNAL` | auth-service からの初回プロビジョン |
| GET /users/:id | ×(internal) | `requireInternal` | `INTERNAL` | gateway `/me` 合成用 |
| POST /internal/users/:id/profile | ×(internal) | `requireInternal` | `INTERNAL` | gateway が自分の userId に限定して転送 |
| GET /internal/users | ×(internal) | `requireInternal` | `INTERNAL` | 通知ファンアウトのロール展開 |
| POST /internal/users/lookup | ×(internal) | `requireInternal` | `INTERNAL` | ログイン許可リスト照会 |
| POST /authz/check | ×(internal) | `requireInternal` | `INTERNAL` | **全サービスの認可判定の起点** |
| GET /internal/users/:id/permissions | ×(internal) | `requireInternal` | `INTERNAL` | 実効権限の取得 |

**循環リスク(重要)**: identity-roster は `/authz/check` の提供元そのもの。現状は
`svc.can` / `svc.decidePolicy` を**インプロセス**で呼んでいる。`createAuthzGranter` は
Service Binding 経由で `/authz/check` を叩くため、identity-roster に素で載せると自己再帰になる。
**このサービスだけ granter をインプロセス実装に差し替える**こと。

### 2.4 member-service

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /health | ×(internal) | なし | `PUBLIC` | セグメント未登録 |
| POST /members/internal/participation | ○(gateway `POST /api/v1/public/participation` 経由・未認証) | inline `x-dub-internal` のみ | `INTERNAL` | 公開受付は gateway 側で防御済みの s2s 転送 |
| GET /members/internal/team-members | ×(internal) | inline `x-dub-internal` | `INTERNAL` | chat のチームメンション展開専用 |
| GET /members/internal/me/participation | ○(gateway `/api/v1/me/participation` 経由) | `x-dub-internal` + `x-dub-user-id` 必須 | `INTERNAL` | 自己参加情報のみ |
| POST /members/internal/me/participation | ○(同上) | 同上(自己行のみ更新) | `INTERNAL` | 自己レコード限定 |
| GET /members/overview | ○ | `requireAny(["identity:read","app:members:view"])` | `appLevel("members","view")` | 名簿 3 ビューの閲覧 |
| GET /members/me/mention-teams | ○ | `requireAuth` のみ | 認証のみ(**要確認**) | 一般メンバーもメンション用に読む必要があり意図的に無権限 |
| GET /members/teams | ○ | `requireAny([...])` | `appLevel("members","view")` | 他アプリも読む正典チーム一覧 |
| POST /members/teams | ○ | `requireAppAccess("members","edit")` | `appLevel("members","edit")` | チーム作成 |
| PATCH /members/teams/:id | ○ | `requireAppAccess("members","edit")` | `appLevel("members","edit")` | チーム更新 |
| DELETE /members/teams/:id | ○ | `requireAppAccess("members","edit")` | `appLevel("members","edit")` | チーム削除 |
| POST /members/people | ○ | `requireAppAccess("members","edit")` | `appLevel("members","edit")` | 名簿行の作成 |
| GET /members/people/by-identity/:identityUserId | ○ | `requireAny([...])` | `appLevel("members","view")` | 名簿行の逆引き |
| POST /members/people/:id/identity-link | ○ | `requireAppAccess("members","edit")` | `appLevel("members","edit")` | identity 紐付け |
| PATCH /members/people/:id | ○ | `requireAppAccess("members","edit")` | `appLevel("members","edit")` | 名簿行の更新 |
| DELETE /members/people/:id | ○ | `requireAppAccess("members","edit")` | `appLevel("members","edit")` | 名簿行の削除 |
| POST /members/participation | ○ | `requireAuth` のみ | `appLevel("participation","view")` | 参加届は `openToAllAuthenticated` |
| GET /members/participation | ○ | `requireAuth` + `identity:read` | `appLevel("participation","view","identity:read")` | 全員分の届一覧 |
| GET /members/participation/:id/candidates | ○ | `requireAuth` + `identity:read` | `appLevel("participation","view","identity:read")` | 他人の名簿行の露出を伴う |
| POST /members/participation/:id/resolve | ○ | `requireAppAccess("participation","edit")` | `appLevel("participation","edit","identity:admin")` | 名簿を書き換える確定操作 |

**OR セマンティクスの衝突(重要)**: `rosterRead = requireAny(["identity:read","app:members:view"])`
は OR。policy-gate の `RequiredKeys` は AND のみで OR を意図的に排除している。
そのまま `["identity:read","app:members:view"]` と書くと**意味が変わり**、
片方しか持たないロール(コメント上「`app:members:view` だけ持つ統括ロール」が実在想定)が 403 になる。
`appLevel("members","view")` に寄せる(= `app:members:view` 単独)のが移行方針として妥当だが、
`identity:read` のみ保持するロールが落ちる。**ロール実データの確認が必要**。

### 2.5 event-service

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /health | ×(internal) | なし | `PUBLIC` | `/events` `/actions` のみ転送 |
| GET /events | ○ | `requireAuth` + `event:read` | `appLevel("events","view","event:read")` | イベント一覧 |
| POST /events | ○ | `requireAuth` + `event:write` | `appLevel("events","edit","event:write")` | 新規作成 |
| GET /events/:id | ○ | `event:read` (event scope) | `appLevel("events","view","event:read")` | 単体取得 |
| PATCH /events/:id | ○ | `event:write` (scope) + phase 遷移時のみ `event:admin` | `appLevel("events","edit","event:write")` | 遷移判定はボディ依存でハンドラ残し |
| DELETE /events/:id | ○ | `event:admin` (scope) | `appLevel("events","edit","event:admin")` | アーカイブ |
| GET /events/:id/participants | ○ | `event:read` (scope) | `appLevel("events","view","event:read")` | 参加者一覧 |
| GET /events/:id/details | ○ | `event:read` (scope) | `appLevel("events","view","event:read")` | 詳細ストアの読取り |
| PUT /events/:id/details | ○ | `event:write` (scope) | `appLevel("events","edit","event:write")` | 詳細ストアの書込み |
| GET /events/:id/section-layout | ○ | `event:read` (scope) | `appLevel("events","view","event:read")` | 共有レイアウト読取り |
| PUT /events/:id/section-layout | ○ | `event:write` (scope) | `appLevel("events","edit","event:write")` | 共有レイアウト書込み |
| GET /events/:id/page-layout | ○ | `event:read` (scope) | `appLevel("events","view","event:read")` | ページレイアウト読取り |
| PUT /events/:id/page-layout | ○ | `event:write` (scope) | `appLevel("events","edit","event:write")` | ページレイアウト書込み |
| GET /events/:id/actions | ○ | `event:read` (scope) | `appLevel("events","view","event:read")` | アクション一覧 |
| POST /events/:id/actions | ○ | `event:write` (scope) | `appLevel("events","edit","event:write")` | アクション作成 |
| GET /actions/:id | ○ | `event:read` (**スコープ無し**) | `appLevel("events","view","event:read")` | 親イベントへのスコープが無い |
| PATCH /actions/:id | ○ | `event:write` (スコープ無し) | `appLevel("events","edit","event:write")` | 同上 |
| DELETE /actions/:id | ○ | `event:write` (スコープ無し・`event:admin` ではない) | `appLevel("events","edit","event:write")` | アーカイブが write 止まり |

**注**: `resourceType:"event"` のリソーススコープは policy-gate の静的テーブルでは表現できない
(`AuthzQuery.resourceId` を渡す口が `PermissionGranter` に無い)。移行でスコープが失われる。

### 2.6 gantt-service

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /health | ○(workers.dev・host ガード対象外) | なし | `PUBLIC` | 死活監視 |
| POST /internal/events-async | ×(internal) | inline `x-dub-internal` | `INTERNAL` | freeq ドレインの着地点 |
| GET /gantt | ○ | `requireAuth` + `event:read` (eventId scope) | `appLevel("gantt","view","event:read")` | チャート全体の読取り |
| GET /gantt/dependencies | ○ | 同上 | `appLevel("gantt","view","event:read")` | 依存線のみの軽量読取り |
| GET /gantt/views | ○ | 同上(自分の行のみ) | `appLevel("gantt","view")` | 自己の表示状態 |
| PUT /gantt/views | ○ | 同上(自分の行のみ) | `appLevel("gantt","view")` | 自己の表示設定の保存 |
| GET /gantt/ws-ticket | ○ | 同上 | `appLevel("gantt","view","event:read")` | 購読は閲覧権限に追従 |
| PATCH /gantt/rows/:taskId | ○ | **`requireAuth` のみ**(guard が `event:read` を明示的に迂回) | `appLevel("gantt","edit","task:write")` | 書込み権限自体は下流 task-service が `task:write` を要求(委譲先あり)。失われるのは**イベントスコープ**(要注意 a-4) |
| GET /ws/:eventId (Hono 外・DO 直結) | ○(gateway バイパス) | HMAC ws-ticket + Origin 検証 | 対象外(DO 自前検証) | 署名付き短命チケットが門 |

### 2.7 task-service

`deps.authz.require()` は `principal.kind === "service"` なら**全チェックを素通し**。
gateway が `x-dub-*` を剥離するため外部からは詐称不能。

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /health | ×(internal) | **なし**(`/internal/*` ガードの外) | `INTERNAL` | パスを `/internal/health` に寄せるべき |
| POST /internal/events-async | ×(internal) | inline `x-dub-internal` | `INTERNAL` | event-service outbox の着地点 |
| GET /tasks/dependencies | ○ | `task:read` | `appLevel("tasks","view")` | 依存グラフの閲覧 |
| GET /tasks | ○ | `task:read` (+`includeArchived` 時 `task:delete`) | `appLevel("tasks","view")` | 一覧閲覧 |
| POST /tasks | ○ | `task:write` (`origin` 指定は service 限定) | `appLevel("tasks","edit")` | タスク作成 |
| GET /tasks/:id | ○ | `task:read` | `appLevel("tasks","view")` | 単一タスク閲覧 |
| PATCH /tasks/:id | ○ | `task:write` (github origin の保護フィールドあり) | `appLevel("tasks","edit")` | タスク更新 |
| DELETE /tasks/:id | ○ | `task:delete` | `appLevel("tasks","edit","task:delete")` | 論理削除は上位権限 |
| GET /tasks/:id/attachments | ○ | `task:read` | `appLevel("tasks","view")` | 添付一覧 |
| POST /tasks/:id/attachments | ○ | `task:write` | `appLevel("tasks","edit")` | 添付の追加 |
| DELETE /tasks/:id/attachments/:attachmentId | ○ | `task:write` | `appLevel("tasks","edit")` | 添付の除去 |
| PUT /tasks/:id/dependencies | ○ | `task:write` + 同一チーム/循環検証 | `appLevel("tasks","edit")` | 依存関係の一括置換 |

**注**: service principal の素通しは policy-gate に相当機能が無い。`INTERNAL` は
「キーの代わりにならない」仕様なので、s2s 呼び出しもキーを要求されるようになる。
内部呼び出し元が権限キーを持たない場合に破綻する。**移行前に呼び出し元の洗い出しが必要**。

### 2.8 file-meta

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /internal/health | ×(internal) | **なし**(`x-dub-internal` 検査も無し) | `INTERNAL` | セグメント未登録だが単独では無防備 |
| POST /internal/events-async | ×(internal) | inline `x-dub-internal` | `INTERNAL` | outbox ドレインの着地点 |
| POST /files/meta | ○ | `requireAuth` + `file:write` | `appLevel("driveshare","edit")` | メタ登録 |
| GET /files/search | ○ | `file:read` + private を owner/`file:admin` で絞込 | `appLevel("driveshare","view")` | 可視性は結果依存 |
| GET /files/meta/:id | ○ | `file:read` + `assertCanRead` | `appLevel("driveshare","view")` | private は所有者判定が必要 |
| PATCH /files/meta/:id | ○ | `file:write` (+ `ownerId` 変更時のみ `file:admin`) | `appLevel("driveshare","edit")` | 所有者付替のみ上位 |
| DELETE /files/meta/:id | ○ | `file:write` のみ(**owner/visibility 判定なし**) | `appLevel("driveshare","edit")` | 他人の private も消せる非対称(要注意 d) |
| POST /files/meta/:id/links | ○ | `file:write` | `appLevel("driveshare","edit")` | リンク追加 |
| DELETE /files/meta/:id/links | ○ | `file:write` | `appLevel("driveshare","edit")` | リンク削除 |
| POST /files | ○ | `file:write` | `appLevel("driveshare","edit")` | R2 実体アップロード |
| GET /files/:id/download | ○ | `file:read` + `assertCanRead` | `appLevel("driveshare","view")` | private は所有者判定 |

### 2.9 drive-proxy

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /internal/health | ×(internal) | **なし**(未認証・明記コメントあり) | `INTERNAL` | セグメント未登録 |
| GET /drive/files | ○ | `requireAuth` + `drive:read` | `appLevel("driveshare","view")` | Drive 一覧/検索 |
| GET /drive/files/:id/embed | ○ | `drive:read` | `appLevel("driveshare","view")` | 埋め込み URL の取得 |
| GET /drive/files/:id | ○ | `drive:read` | `appLevel("driveshare","view")` | 単一ファイルのメタ取得 |
| GET /drive/sheets/:id/values | ○ | `drive:read` | `appLevel("driveshare","view")` | シート値の読取 |
| POST /drive/files | ○ | `drive:write` | `appLevel("driveshare","edit")` | ファイル作成 |
| POST /drive/files/:id/move | ○ | `drive:write` | `appLevel("driveshare","edit")` | 移動 |
| POST /drive/files/:id/trash | ○ | `drive:write` | `appLevel("driveshare","edit")` | ゴミ箱送り |
| POST /drive/sheets/:id/values | ○ | `drive:write` | `appLevel("driveshare","edit")` | シート値の書込 |
| GET /drive/health/quota | ○(パス露出) | `requireInternal` のみ | `INTERNAL` | エッジ 404 が無く受信側 1 枚のみ(要注意 a-5) |
| POST /drive/watch | ○(パス露出) | `requireInternal` のみ | `INTERNAL` | watch チャネル発行は運用専用 |
| POST /drive/watch/:channelId/stop | ○(パス露出) | `requireInternal` のみ | `INTERNAL` | チャネル停止は運用専用 |

### 2.10 drive-share-service (**採用済み・参照実装**)

**唯一の移行済みサービス**。`src/policy-table.ts` の `POLICY_TABLE` が全 12 ルートを宣言し、
`src/app.ts:43` が `policyGate` を最初にマウント、`test/policy-table.test.ts` が
`assertRouteCoverage(app, POLICY_TABLE)` で表とルートの乖離を CI で落とす。
サービス内に他の認可チェックは残っていない。下表の「適用済みルール」は実際にテーブルに
書かれている値であり、他サービスの「提案ルール」列とは意味が違う(こちらは確定済み)。

| METHOD /path | 外部到達 | 適用済みルール | 根拠 |
|---|---|---|---|
| GET /internal/health | ×(internal) | `INTERNAL` | 唯一の呼び出し元 app-health-monitor が Service Binding 経由で `x-dub-internal` を付けて叩くため `INTERNAL` でコスト増は無い。`PUBLIC` は「意図して公開」の宣言であり実態と合わない(判断理由は `policy-table.ts` の冒頭コメント参照) |
| GET /driveshare/files | ○ | `appLevel("driveshare","view","drive:read")` | ファイル一覧 |
| GET /driveshare/files/:id/permissions | ○ | `appLevel("driveshare","view","drive:read")` | 共有状況の参照 |
| GET /driveshare/role-grants | ○ | `appLevel("driveshare","view","drive:read")` | ロール付与一覧 |
| GET /driveshare/files/:id/role-grants | ○ | `appLevel("driveshare","view","drive:read")` | 詳細パネル用 |
| POST /driveshare/files/:id/permissions | ○ | `appLevel("driveshare","edit","drive:write")` | 権限付与 |
| PATCH /driveshare/files/:id/permissions/:permId | ○ | `appLevel("driveshare","edit","drive:write")` | ロール変更 |
| DELETE /driveshare/files/:id/permissions/:permId | ○ | `appLevel("driveshare","edit","drive:write")` | 権限剥奪 |
| POST /driveshare/files/:id/role-grants | ○ | `appLevel("driveshare","edit","drive:write")` | ファンアウト付与 |
| DELETE /driveshare/files/:id/role-grants/:roleId | ○ | `appLevel("driveshare","edit","drive:write")` | 付与の取消 |
| POST /driveshare/files/:id/role-grants/:roleId/reapply | ○ | `appLevel("driveshare","edit","drive:write")` | 差分の再適用 |
| PUT /driveshare/files/:id/link | ○ | `appLevel("driveshare","edit","drive:write")` | リンク共有 on/off |

**移行前との差分**: 旧実装は `requireAuth` + `drive:read`/`drive:write` のみで、ロール管理の
3 層(無効/閲覧/編集)を参照していなかった。`appLevel` でその層を加えたため、レガシーな
`drive:write` キーだけを持つ「無効」「閲覧」設定のロールは API からも書けなくなった。

### 2.11 chat-service

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /health | ○(workers.dev 直) | なし | `PUBLIC` | 死活監視のみ |
| POST /internal/system-messages | ×(internal) | inline `x-dub-internal` | `INTERNAL` | notification からのシステム投稿 |
| GET /chat/unfurl | ○ | `requireAuth` | `appLevel("chat","view")` | OGP 取得プロキシ |
| GET /chat/channels | ○ | `requireAuth`(自分の所属のみ) | `appLevel("chat","view")` | 参加チャンネル閲覧 |
| POST /chat/channels | ○ | `requireAuth` + `chat:create` | `appLevel("chat","edit","chat:create")` | チャンネル作成 |
| GET /chat/channels/:id | ○ | `requireAuth` + `loadReadable` | `appLevel("chat","view")` | 可視性で判定 |
| PATCH /chat/channels/:id | ○ | `requireAuth` + `isChannelAdmin` | `appLevel("chat","edit")` | 設定変更は管理者層 |
| GET /chat/channels/:id/members | ○ | `requireAuth` + `loadReadable` | `appLevel("chat","view")` | メンバー一覧 |
| POST /chat/channels/:id/members | ○ | `requireAuth` + `isChannelAdmin` | `appLevel("chat","edit")` | メンバー追加 |
| DELETE /chat/channels/:id/members/:userId | ○ | self または `isChannelAdmin` | `appLevel("chat","edit")` | 退出は本人、除名は管理者 |
| GET /chat/channels/:id/pins | ○ | `requireAuth` + `loadReadable` | `appLevel("chat","view")` | ピン一覧 |
| POST /chat/channels/:id/pins | ○ | `loadReadable` + `ensureCanWrite` | `appLevel("chat","edit")` | ピン切替は書込み相当 |
| POST /chat/channels/:id/read | ○ | `loadReadable`(自分の既読のみ) | `appLevel("chat","view")` | 本人スコープ |
| GET /chat/channels/:id/ws-ticket | ○ | `loadReadable` | `appLevel("chat","view")` | 購読は閲覧権限に追従 |
| GET /chat/search | ○ | `requireAuth`(userId スコープ) | `appLevel("chat","view")` | 読める範囲の検索 |
| GET /chat/messages | ○ | `loadReadable` | `appLevel("chat","view")` | メッセージ閲覧 |
| POST /chat/messages | ○ | `loadReadable` + `ensureCanWrite` | `appLevel("chat","edit")` | 投稿 |
| PATCH /chat/messages/:id | ○ | 投稿者本人のみ | `appLevel("chat","edit")` | 編集 |
| DELETE /chat/messages/:id | ○ | author または channel admin/`chat:moderate` | `appLevel("chat","edit")` | 削除 |
| POST /chat/messages/:id/reactions | ○ | `loadReadable` + `ensureCanWrite` | `appLevel("chat","edit")` | リアクション |
| GET /chat/unread | ○ | `requireAuth`(本人スコープ) | `appLevel("chat","view")` | 未読集計 |
| GET /chat/settings/deletion-policy | ○ | `requireAuth` | `appLevel("chat","view")` | 設定表示 |
| PATCH /chat/settings/deletion-policy | ○ | `requireAuth` + `chat:moderate` | `appLevel("chat","edit","chat:moderate")` | 削除ポリシー変更 |
| GET /ws/:channelId (DO) | ○(workers.dev 直) | Origin + HMAC ws-ticket | 対象外(DO 自前検証) | 発券時に読取り権限を確認済み |
| `ChatRoom.publish()` (DO RPC) | ×(internal) | なし(binding のみ) | 対象外 | HTTP マスターからの fanout 専用 |

### 2.12 notification

`mountNotif()` が全ルートを **2 回**登録する(`""` = 内部 binding 用、`"/notifications"` = gateway 用)。
素パス側は外部到達不可。表では代表形のみ示し、素パス側は末尾にまとめる。

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /internal/health | ○(workers.dev 直・例外許可) | なし | `PUBLIC` | 死活監視のみ |
| POST /internal/events-async | ×(internal) | inline `x-dub-internal` | `INTERNAL` | freeq からのイベント投入 |
| POST /notifications/notify | ×(internal・エッジ 404) | inline `x-dub-internal` | `INTERNAL` | サービス間の通知投入 |
| POST /notifications/release | ○ | `requireAuth` + `notif:admin` | `appLevel("notifications","edit","notif:admin")` | リリースノート公開 |
| POST /notifications/internal/seed-releases | ×(internal・エッジ 404) | inline `x-dub-internal` | `INTERNAL` | デプロイフックからの再シード |
| GET /notifications/manage | ○ | `requireAuth` + `notif:broadcast_publish` | `appLevel("notifications","view","notif:broadcast_publish")` | admin 宛通知の管理一覧 |
| POST /notifications/manage/:id/publish | ○ | 同上 | `appLevel("notifications","edit","notif:broadcast_publish")` | 全メンバーへの配信 |
| POST /notifications/manage/publish-batch | ○ | 同上 | `appLevel("notifications","edit","notif:broadcast_publish")` | 一括配信 |
| POST /notifications/manage/:id/unpublish | ○ | 同上 | `appLevel("notifications","edit","notif:broadcast_publish")` | 配信の撤回 |
| POST /notifications/manage/unpublish-batch | ○ | 同上 | `appLevel("notifications","edit","notif:broadcast_publish")` | 一括撤回 |
| GET /notifications/inbox | ○ | `requireAuth`(本人スコープ + `isAdminViewer`) | `appLevel("notifications","view","notif:inbox:self")` | 本人受信箱 |
| GET /notifications/inbox/ws-ticket | ○ | `requireAuth` | `appLevel("notifications","view","notif:inbox:self")` | 本人 DO への RT チケット |
| GET /notifications/inbox/unread-count | ○ | `requireAuth` | `appLevel("notifications","view","notif:inbox:self")` | 本人未読数 |
| PATCH /notifications/inbox/:id/read | ○ | `requireAuth` + userId スコープ | `appLevel("notifications","view","notif:inbox:self")` | 本人の既読操作 |
| PATCH /notifications/inbox/:id/unread | ○ | 同上 | `appLevel("notifications","view","notif:inbox:self")` | 本人の未読戻し |
| POST /notifications/inbox/read-all | ○ | 同上 | `appLevel("notifications","view","notif:inbox:self")` | 本人の一括既読 |
| GET /notifications/preferences | ○ | 同上 | `appLevel("notifications","view","notif:prefs:self")` | 本人設定の取得 |
| PATCH /notifications/preferences | ○ | 同上 | `appLevel("notifications","edit","notif:prefs:self")` | 本人設定の更新 |
| POST /feedback | ○ | `requireAuth` のみ | `appLevel("notifications","view")` | 認証済み全員が投稿可(設計通り) |
| GET /feedback | ○ | `requireAuth` + `notif:admin` | `appLevel("notifications","view","notif:admin")` | 一覧は管理者 |
| PATCH /feedback/:id/read | ○ | `requireAuth` + `notif:admin` | `appLevel("notifications","edit","notif:admin")` | 既読化は管理者 |
| GET /ws/:userId (DO) | ○(workers.dev 直) | Origin + HMAC ws-ticket | 対象外(DO 自前検証) | 発券は `/inbox/ws-ticket` |

**素パス側(内部 binding 用・外部到達不可)**: `POST /notify`, `POST /release`,
`POST /internal/seed-releases`, `GET /manage`, `POST /manage/:id/publish`,
`POST /manage/publish-batch`, `POST /manage/:id/unpublish`, `POST /manage/unpublish-batch`,
`GET /inbox`, `GET /inbox/ws-ticket`, `GET /inbox/unread-count`, `PATCH /inbox/:id/read`,
`PATCH /inbox/:id/unread`, `POST /inbox/read-all`, `GET /preferences`, `PATCH /preferences`。
**二重登録のためポリシー表も 2 系統必要**(同じキーを 2 回書く)。

**要確認**: `app.ts:256-257` のコメントが「`notif:inbox:self` / `notif:prefs:self` は
PERMISSION_CATALOG に無い」と主張しているが、`identity.ts:43,44` に**実在する**。
コメントの陳腐化と思われるが、提案の前提になるため確認が要る。

### 2.13 mail-gateway

`withAuth(k)` = `requireAuth()` + `requirePermission(k)`。

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /internal/health | ×(internal) | **なし**(`x-dub-internal` 検査も無し) | `PUBLIC` | 生存確認のみ |
| GET /internal/health/ready | ×(internal) | inline `x-dub-internal` | `INTERNAL` | provider 設定状況を返す |
| POST /send | ×(internal・エッジ 404) | inline `x-dub-internal` (+ userId あれば `mail:send` fresh 再検査) | `INTERNAL` | システム送信口(open-relay ガード) |
| GET /internal/status | ×(internal) | inline `x-dub-internal` | `INTERNAL` | 送信レート状況 |
| GET /health/quota | ×(internal) | inline `x-dub-internal` | `INTERNAL` | provider 設定の露出 |
| POST /mail/outbox | ○ | `withAuth("mail:send")` | `appLevel("mail","edit","mail:send")` | ユーザー発信の送信 |
| GET /mail/messages | ○ | `withAuth("mail:read")` + `scopeOf` | `appLevel("mail","view","mail:read")` | 受信一覧 |
| GET /mail/messages/:id | ○ | `withAuth("mail:read")` + `scopeOf` | `appLevel("mail","view","mail:read")` | 受信本文 |
| POST /mail/messages/:id/read | ○ | `withAuth("mail:read")` + `scopeOf` | `appLevel("mail","view","mail:read")` | 既読フラグ |
| GET /mail/messages/:id/attachments/:attId | ○ | `withAuth("mail:read")` | `appLevel("mail","view","mail:read")` | 受信添付 |
| GET /mail/sent | ○ | `withAuth("mail:read")` + `scopeOf` | `appLevel("mail","view","mail:read")` | 送信済み一覧 |
| GET /mail/sent/:id | ○ | `withAuth("mail:read")` + `scopeOf` | `appLevel("mail","view","mail:read")` | 送信済み本文 |
| GET /mail/sent/:id/attachments/:attId | ○ | `withAuth("mail:read")` | `appLevel("mail","view","mail:read")` | 送信済み添付 |
| POST /mail/scheduled | ○ | `withAuth("mail:send")` | `appLevel("mail","edit","mail:send")` | 予約送信の作成 |
| GET /mail/scheduled | ○ | `withAuth("mail:read")` + `scopeOf` | `appLevel("mail","view","mail:read")` | 予約一覧 |
| GET /mail/scheduled/:id | ○ | `withAuth("mail:read")` + `scopeOf` | `appLevel("mail","view","mail:read")` | 予約詳細 |
| PATCH /mail/scheduled/:id | ○ | `withAuth("mail:send")` + owner 一致 | `appLevel("mail","edit","mail:send")` | 予約内容の変更 |
| DELETE /mail/scheduled/:id | ○ | `withAuth("mail:send")` + owner 一致 | `appLevel("mail","edit","mail:send")` | 予約取消 |
| GET /mail/threads/:id | ○ | `withAuth("mail:read")` + `scopeOf` | `appLevel("mail","view","mail:read")` | スレッド閲覧 |
| GET /mail/flags | ○ | `withAuth("mail:read")` + `ownerOf` | `appLevel("mail","view","mail:read")` | 個人のスター/アーカイブ |
| POST /mail/flags/:threadId | ○ | `withAuth("mail:read")` + `ownerOf` | `appLevel("mail","view","mail:read")` | 自分のフラグ更新 |
| GET /mail/mailboxes | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 共有メールボックス設定 |
| POST /mail/mailboxes/:id | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | メールボックス定義の変更 |
| GET /mail/admin/email-routing/addresses | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | CF Email Routing の管理面 |
| POST /mail/admin/email-routing/addresses | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 転送先アドレス発行 |
| DELETE /mail/admin/email-routing/addresses/:id | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 転送先アドレス削除 |
| GET /mail/admin/email-routing/roster-addresses | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 名簿同期元の列挙 |
| GET /mail/admin/email-routing/issued-addresses | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 発行済み一覧 |
| POST /mail/admin/email-routing/issued-addresses | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | アドレス発行 |
| PATCH /mail/admin/email-routing/issued-addresses/:id | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 有効/無効切替 |
| DELETE /mail/admin/email-routing/issued-addresses/:id | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 失効 |
| GET /mail/admin/email-routing/rules | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 規則の閲覧 |
| POST /mail/admin/email-routing/rules | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 規則の作成 |
| PATCH /mail/admin/email-routing/rules/:id | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 規則の更新 |
| DELETE /mail/admin/email-routing/rules/:id | ○ | `withAuth("mail:admin")` | `["mail:admin"]` | 規則の削除 |

**別 Worker (`wrangler.standalone.toml`・`workers_dev = true` を確認済み)**:

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET / (standalone) | ○(`*.workers.dev` で公開) | なし | `PUBLIC` | 送信フォームの静的 HTML |
| GET /healthz (standalone) | ○(同上) | なし | `PUBLIC` | 生存確認 |
| POST /compose/send (standalone) | ○(同上) | 同一オリジン判定 + `COMPOSE_TOKEN` Bearer | **語彙外(要注意 b)** | gateway を通らない送信口 |

### 2.14 mail-automation

gateway にセグメントが無く全ルート外部到達不可。
app レベルで `internalOnly` -> `requireAuth()` が全ルートに適用。

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| POST /internal/events-async | ×(internal) | entry の inline `x-dub-internal` | `INTERNAL` | freeq からのイベント配送 |
| GET /rules | ×(internal) | `internalOnly` + `requireAuth` + `mail:read` | `["mail:read"]` | 自動返信ルールの閲覧 |
| POST /rules | ×(internal) | + `mail:admin` | `["mail:admin"]` | ルールの作成 |
| GET /rules/:id | ×(internal) | + `mail:read` | `["mail:read"]` | ルール詳細 |
| PATCH /rules/:id | ×(internal) | + `mail:admin` | `["mail:admin"]` | ルールの更新 |
| DELETE /rules/:id | ×(internal) | + `mail:admin` | `["mail:admin"]` | ルールの論理削除 |
| GET /templates | ×(internal) | + `mail:read` | `["mail:read"]` | テンプレートの閲覧 |
| POST /templates | ×(internal) | + `mail:admin` | `["mail:admin"]` | テンプレートの作成 |
| PATCH /templates/:id | ×(internal) | + `mail:admin` | `["mail:admin"]` | テンプレートの更新 |
| POST /process | ×(internal) | + `mail:admin` | `["mail:admin"]` | 実際に自動返信を送信 |
| POST /dry-run | ×(internal) | + `mail:read` | `["mail:read"]` | 送信せず判定のみ |
| GET /decisions | ×(internal) | + `mail:read` | `["mail:read"]` | 判定ログの閲覧 |
| GET /settings | ×(internal) | + `mail:read` | `["mail:read"]` | キルスイッチ状態 |
| PATCH /settings | ×(internal) | + `mail:admin` | `["mail:admin"]` | キルスイッチの変更 |

**注**: `INTERNAL` と `RequiredKeys` は同時に書けない(1 ルール 1 形)。
これらは「内部専用 **かつ** キー必須」なので、語彙上どちらかを捨てることになる。
`internalOnly` は app レベル middleware として policy-gate と併用するのが現実解。

### 2.15 github-sync

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /internal/health | ×(internal) | `/internal/*` 一括 `x-dub-internal` | `INTERNAL` | セグメント未登録 |
| POST /internal/events-async | ×(internal) | 同上 | `INTERNAL` | freeq ドレインの着地点 |
| POST /internal/webhooks-async | ×(internal) | 同上 | `INTERNAL` | webhook-ingest からの転送 |
| POST /internal/reconcile/kick | ×(internal) | 同上 | `INTERNAL` | デプロイ後の運用キック |
| GET /github/links | ○ | `requireAuth` + `github:read` | `["github:read"]` | 連携一覧の閲覧 |
| POST /github/links | ○ | `github:write` | `["github:write"]` | task-issue 紐付けの作成 |
| DELETE /github/links/:id | ○ | `github:write` | `["github:write"]` | 紐付けの削除 |
| GET /github/repos | ○ | `github:read` | `["github:read"]` | 登録リポジトリの閲覧 |
| POST /github/repos | ○ | `github:admin` | `["github:admin"]` | リポジトリ登録は管理操作 |
| PATCH /github/repos/:id | ○ | `github:admin` | `["github:admin"]` | 連携設定の変更 |
| DELETE /github/repos/:id | ○ | `github:admin` | `["github:admin"]` | 連携解除 |
| POST /github/sync | ○ | `github:sync` | `["github:sync"]` | 同期ジョブの起動 |
| GET /github/sync/runs | ○ | `github:read` | `["github:read"]` | 実行履歴の閲覧 |
| GET /github/sync/runs/:id | ○ | `github:read` | `["github:read"]` | 単一実行の閲覧 |

**注**: `src/auth.ts` の「`github:*` は PERMISSION_CATALOG に無い」コメントは**陳腐化**。
`identity.ts:58-61` に実在するので `asPermissionKey` のキャストは不要。

### 2.16 deploy-service

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /health | ×(internal) | なし | `PUBLIC` | セグメント未登録 |
| POST /deploy/sites | ○ | `requireAuth` + `infra:admin` (fresh) | `appLevel("lp","edit","infra:admin")` | サイト新規作成 |
| GET /deploy/sites | ○ | `infra:read` | `appLevel("lp","view","infra:read")` | サイト一覧 |
| POST /deploy/deployments | ○ | `infra:deploy` (fresh) | `appLevel("lp","edit","infra:deploy")` | デプロイ実行 |
| GET /deploy/deployments | ○ | `infra:read` | `appLevel("lp","view","infra:read")` | デプロイ履歴 |
| GET /deploy/deployments/:id | ○ | `infra:read` | `appLevel("lp","view","infra:read")` | デプロイ詳細 |
| POST /deploy/dns/records | ○ | `infra:dns` (fresh) | `appLevel("lp","edit","infra:dns")` | DNS レコード作成 |
| GET /deploy/domains | ○ | `infra:read` | `appLevel("lp","view","infra:read")` | ゾーン/ドメイン一覧 |

**`fresh` について(訂正)**: `createAuthzGranter` は**キャッシュを一切持たない**
(`authz.ts` に cache 実装なし)ので、`fresh: true` の意図は移行後も**保たれる**。
失うのではなく、逆に全ルートが常時 fresh になり、identity への subrequest が増える。
無料枠の subrequest 上限に対する負荷評価が必要。

### 2.17 audit-log

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /internal/health | ×(internal) | `/internal/*` の `x-dub-internal` 存在チェック | `INTERNAL` | 内部 liveness |
| POST /internal/log | ×(internal) | 同上 | `INTERNAL` | 同期書込(公開不可) |
| POST /internal/audit-async | ×(internal) | 同上 | `INTERNAL` | outbox drain の着地点 |
| GET /audit/logs | ○ | `requireAuth` + `audit:read` | `["audit:read"]` | APP_MANIFEST に audit アプリが無く `appLevel` 不可 |
| GET /audit/logs/:id | ○ | `requireAuth` + `audit:read` | `["audit:read"]` | 同上 |

### 2.18 usage-meter

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /usage/summary | ○ | `requireAuth()` のみ(identity 非照会) | `appLevel("usage","view")` | `openToAllAuthenticated` なので現行と等価 |
| GET /internal/health | ×(internal) | なし | `INTERNAL` | `workers_dev = false` |
| GET / | ×(internal) | なし | `INTERNAL` | 文字列を返すだけ |
| POST /internal/meter/kick | ×(internal) | `x-dub-internal` の**存在のみ**検査 | `INTERNAL` | DO alarm のブートストラップ |
| POST /internal/meter/refresh | ×(internal) | 同上 | `INTERNAL` | 全コレクタ再実行(重い) |

`/usage/` 配下に紛れ込んだ internal ルートは**無し**(外部に出るのは summary のみ)を確認済み。
非 HTTP: `MeterDO.fetch()` / `MeterDO.alarm()`(日次収集)。

### 2.19 webhook-ingest

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| POST /hooks/:source | ○(専用ドメイン・gateway 非経由) | ソース別署名検証のみ(github HMAC / stripe HMAC+replay 窓 / drive token / gmail OIDC JWT。secret 未設定は fail-closed) | `PUBLIC` + ハンドラ残し | プロバイダ受信は未認証必須 |
| GET /hooks/:source | ○(同上) | **なし** | `PUBLIC` | watch ハンドシェイク、`{status,source}` のみ |
| GET /api/v1/webhooks/deliveries | **×(到達不能・パス不整合)** | `requireAuth` + `webhook:read` | `["webhook:read"]` | 要注意 a-6 |
| GET /api/v1/webhooks/deliveries/:id | **×(同上)** | `requireAuth` + `webhook:read` | `["webhook:read"]` | 同上 |
| GET /internal/health | 要確認(`workers_dev` 未指定) | なし | `INTERNAL` | 生存確認 |

非 HTTP: `scheduled()`(cron `17 3 * * *`・30 日保持スイープ)。Queue は producer のみ。
`wrangler.toml:11` の `routes`(hooks.developershub.jp) は**コメントアウト**されており、
実際の受信ドメインは infra 側設定依存 = 要確認。

### 2.20 app-health-monitor

`workers_dev = true`(両 toml)かつ `index.ts` に host ガード**無し** = `*.workers.dev` で公開。

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET / | ○(workers.dev 公開) | なし | `PUBLIC` | 文字列のみ |
| GET /internal/health | ○(同上) | なし | `PUBLIC` | 生存確認 |
| POST /internal/monitor/kick | ○(同上) | `x-monitor-token` 完全一致(未設定は 403 fail-closed) | **語彙外(要注意 b)** | DO hourly alarm の起動 |
| POST /internal/monitor/run | ○(同上) | 同上 | **語彙外** | 全 binding の実プローブ + 通知送信 |
| GET /internal/monitor/status | ○(同上) | 同上 | **語彙外** | 死活スナップショット(インフラ構成の露出) |

`x-dub-internal` を信頼シグナルにしていないのは**正しい判断**(公開オリジンでは誰でも付けられる)。
非 HTTP: `MonitorDO.alarm()`(毎時自己再スケジュール)。

### 2.21 freeq-drain

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /internal/health | ×(internal) | なし | `INTERNAL` | `workers_dev = false` |
| GET / | ×(internal) | なし | `INTERNAL` | 文字列のみ |
| POST /internal/drain/kick | ×(internal) | `x-dub-internal` の**値まで**検証(他より厳密) | `INTERNAL` | DO alarm のブートストラップ |

非 HTTP: `FreeqDrainDO.alarm()`(60 秒ドレイン + 6 時間ごと prune)。

### 2.22 commander-service

gateway に**セグメントもバインディングも無い**。フロントは gateway を経由せず
`VITE_COMMANDER_API ?? "http://127.0.0.1:8787"` を直接叩き、`x-commander-token` のみ送る。
`app.use("*", cors({ origin: "*" }))` + **mutation だけ**の条件付きトークンガード
(`COMMANDER_OPERATOR_TOKEN` が設定されている時のみ)。

| METHOD /path | 外部到達 | 現在の認可 | 提案ルール | 根拠 |
|---|---|---|---|---|
| GET /health | 要確認 | **なし** | `PUBLIC` | 死活監視のみ |
| GET /features | 要確認 | **なし** | `appLevel("commander","view")` | フェーズ盤の閲覧 |
| POST /features | 要確認 | 共有シークレット(未設定なら**なし**) | `appLevel("commander","edit")` | フィーチャー作成 |
| GET /features/:id | 要確認 | **なし** | `appLevel("commander","view")` | 単体 + 遷移履歴 |
| POST /features/:id/transition | 要確認 | 共有シークレット(未設定なら**なし**) | `appLevel("commander","edit")` | demo-staging-本番の承認操作 |
| GET /features/:id/tasks | 要確認 | **なし** | `appLevel("commander","view")` | 配下タスク一覧 |
| POST /features/:id/tasks | 要確認 | 共有シークレット(同上) | `appLevel("commander","edit")` | タスク作成 |
| GET /tasks | 要確認 | **なし** | `appLevel("commander","view")` | ワークボード読取り |
| POST /tasks | 要確認 | 共有シークレット(同上) | `appLevel("commander","edit")` | feature + task 同時作成 |
| POST /tasks/backfill-urls | 要確認 | 共有シークレット(同上) | `appLevel("commander","edit")` | 全 run 走査の一括処理 |
| PATCH /tasks/:id | 要確認 | 共有シークレット(同上) | `appLevel("commander","edit")` | タスク状態変更 |
| GET /runs | 要確認 | **なし** | `appLevel("commander","view")` | 実行履歴(prompt/cwd を含む) |
| POST /runs | 要確認 | 共有シークレット(同上) | `INTERNAL`(要確認) | daemon のみが呼ぶ |
| GET /runs/:id | 要確認 | **なし** | `appLevel("commander","view")` | run 詳細 + 出力ログ |
| GET /runs/:id/events | 要確認 | **なし** | `appLevel("commander","view")` | 実行ログの閲覧 |
| POST /runs/:id/events | 要確認 | 共有シークレット(同上) | `INTERNAL`(要確認) | daemon の sink が追記 |
| GET /chats | 要確認 | **なし** | `appLevel("commander","view")` | AI チャット履歴一覧 |
| POST /chats | 要確認 | 共有シークレット(同上) | `appLevel("commander","edit")` | セッション作成 |
| GET /chats/:id | 要確認 | **なし** | `appLevel("commander","view")` | 会話本文の閲覧 |
| PATCH /chats/:id | 要確認 | 共有シークレット(同上) | `appLevel("commander","edit")` | タイトル変更 |
| DELETE /chats/:id | 要確認 | 共有シークレット(同上) | `appLevel("commander","edit")` | 物理削除 |
| POST /chats/:id/messages | 要確認 | 共有シークレット(同上) | `appLevel("commander","edit")` | メッセージ追記 |
| PATCH /chats/:id/messages/:mid | 要確認 | 共有シークレット(同上) | `appLevel("commander","edit")` | ストリーミング中の更新 |

**外部到達が「要確認」の理由(訂正済み)**: commander-service は **`fb811d04` 時点で本番にも
staging にもデプロイされていない**。根拠は 4 点とも不在であること:

| 確認先 | 結果 |
|---|---|
| `infra/deploy/deploy-prod.sh` の 22 本の deploy 行 | commander は**不在** |
| `infra/deploy/staging-worker-set.sh` | **不在** |
| CI ワークフロー | **不在** |
| `deploy-state/*.json`(demo/staging/prod の記録) | **不在** |

加えて `wrangler.free.toml:14` の D1 は `database_id = "PLACEHOLDER_DUB_CORE_D1_ID"` のままで、
**そのままでは deploy 自体が通らない**。よって **現状の外部露出は無い**。

ただし次の 2 点は実在するリスクとして残る:

1. **手動 deploy した瞬間に全世界公開になる**。両 toml に `workers_dev` の行が無い
   (他 17 本の `wrangler.free.toml` は `workers_dev = false` を明示している)。
   既定は公開側なので、1 回の手動 deploy で本表の無認可 GET が全部インターネットに出る。
2. **ローカル dev でも読める**。`commander/dev-up.sh` は 127.0.0.1 で起動するが、
   `src/app.ts:50` が `cors({ origin: "*" })` を付けており GET は無認可。オペレータが
   任意のサイトを開けば、そのページの JS が `http://127.0.0.1:<port>` 宛に fetch して
   run ログ・prompt・cwd・AI 会話本文を読み出せる。

したがって表の「外部到達」列は全ルート「×(未デプロイ)」が正。ただし**設定 1 行で ○ に
反転する**ため、ポリシー表の整備は deploy より先に済ませる。

---

## 3. 要注意リスト

### (a) 現在どの認可もかかっておらず外部到達可能なルート

**最優先。これが本プロジェクトの存在理由。**

| # | 対象 | 内容 | 深刻度 |
|---|---|---|---|
| a-1 | **commander-service の GET 全 11 本** | `/features` `/features/:id` `/features/:id/tasks` `/tasks` `/runs` `/runs/:id` `/runs/:id/events` `/chats` `/chats/:id` `/health` が**完全無認可**。prompt / cwd / 実行ログ / AI 会話本文が読める。`COMMANDER_OPERATOR_TOKEN` 未設定なら mutation 12 本も全開放。**ただし本番/staging 未デプロイのため現状の外部露出は無い**(2.22)。実在するのは (1) 両 toml に `workers_dev` 行が無く手動 deploy の瞬間に全世界公開になる潜在リスク、(2) ローカル dev でも `cors({origin:"*"})`(`src/app.ts:50`)+ GET 無認可のため、オペレータが開いた任意サイトの JS が 127.0.0.1 の API を読めるリスク | 高(露出時は最高) |
| a-2 | `POST /api/v1/public/participation` の Turnstile 回避 | 検証は `TURNSTILE_SECRET && p.turnstileToken` の**両方が真のときだけ**。クライアントが `turnstileToken` を送らなければ検証ごとスキップ。残る防御は IP 単位 rate-limit のみで、既定 limiter は per-isolate in-memory(`RATE_LIMIT_KV` は wrangler でコメントアウト)。未認証で member-service の内部書込みに到達する唯一の経路。※コード上は意図的なトレードオフと明記されている | 高 |
| a-3 | `POST /auth/test-login` / `POST /auth/demo-login` | 任意 userId(前者)・固定デモ口座(後者)のセッションを**無資格で発行**。ただし守りは env フラグ 1 枚ではなく**二重**: `env.ts:101` の `DUB_TEST_LOGIN === "1" && !isProduction`(両方必要)、`env.ts:95` の `ENVIRONMENT ?? "production"` で**未設定時は本番扱いの fail-closed**、さらに `wrangler.toml` / `wrangler.free.toml` の両方で `ENVIRONMENT = "production"` を明示。悪用には **2 つの誤設定が同時に**必要(本番側で `ENVIRONMENT` を非 production に変える **かつ** `DUB_TEST_LOGIN=1` を入れる) | 中 |
| a-4 | `PATCH /gantt/rows/:taskId` | `guard()` が `event:read` を**明示的に迂回**し `requireAuth` のみ。ただし「実効的な認可が無い」は誤り — 下流 task-service が `task:write` を要求し(`services/task-service/src/app.ts:263`)、gantt は `principal.ts:16` 経由で呼び出し元 userId を伝播するのでユーザー principal として評価される。残る穴は**イベントスコープの喪失**: `event:read` を持たないイベントのタスク日程でも、`task:write` さえあれば改竄でき `publishRowMoved` で RT 配信される | 中 |
| a-5 | drive-proxy の `/drive/health/quota` `/drive/watch` `/drive/watch/:channelId/stop` | `/drive/*` 配下なので gateway を通過するが、`routes.ts` の `internalOnlyPaths` に drive の項が**無く**エッジ 404 の二重防御がゼロ。守りは受信側 `requireInternal` 1 枚のみ。`proxy.ts` のヘッダ剥離が退行すれば即露出。`internalOnlyPaths: ["/drive/health/", "/drive/watch"]` の追加を推奨 | 中 |
| a-6 | **webhook-ingest の管理 2 本が死んでいる** | gateway は `/api/v1` を剥がして `/webhooks/deliveries` を転送するが、webhook-ingest は `/api/v1/webhooks/deliveries` で登録。よって gateway 経由は受信側で 404 になる。**セキュリティの穴ではなく機能不全**(認可が緩いのではなく、配信管理 UI が 404 で動かない)。本節に置いているのは移行時に表へ載せる前提が崩れるため | 中(機能不全・セキュリティ影響なし) |
| a-7 | app-health-monitor の公開オリジン | `workers_dev=true` かつ chat/gantt/notification が持つ `host === "svc"` ガードが**無い**。`GET /` と `/internal/health` は無認可で誰でも到達。control 3 本はトークン保護済みだが、総当たり面が公開されている | 低〜中 |
| a-8 | `GET /hooks/:source`(webhook-ingest) | 認可ゼロ。どのプロバイダが live かを外部から列挙できる。情報量は小さい | 低 |
| a-9 | 無防備な health 群 | `task-service GET /health`、`file-meta GET /internal/health`、`drive-proxy GET /internal/health`、`mail-gateway GET /internal/health` は `x-dub-internal` 検査すら無い。現状エッジ到達不可だが単独では無防備 | 低 |

### (b) PERMISSION_CATALOG に対応キーが無く、新規追加が必要なもの

**ドメインキーの不足は無い。** `github:*` / `drive:*` / `file:*` / `task:*` / `notif:inbox:self` /
`notif:prefs:self` は全て実在する(複数サービスの「カタログに無い」コメントは**全て陳腐化**。
github-sync `src/auth.ts`、drive-proxy `src/permissions.ts`、notification `app.ts:256` の 3 箇所)。

不足しているのは**キーではなく語彙**で、**5 件**(b-2〜b-6)。
当初 b-1 として挙げた「`INTERNAL` 未 export」は事実誤認で、実際は export 済み(下表参照)。

| # | 不足 | 影響 | 推奨 |
|---|---|---|---|
| ~~b-1~~ | ~~`INTERNAL` が `index.ts` から export されていない~~ | **誤り(訂正済み)**。`packages/policy-gate/src/index.ts:12` で `PUBLIC` / `INTERNAL` / `appLevel` 等と並べて export 済み。drive-share-service の `policy-table.ts` が実際に `import { definePolicyTable, appLevel, INTERNAL } from "@dub/policy-gate"` している | 対応不要 |
| b-2 | 「認証のみ・キー不要」を表す形が無い | `RequiredKeys` は非空が型で強制、`PUBLIC` は認証を外す。gateway `/me` 系 7 本、member `GET /members/me/mention-teams`、notification `POST /feedback` が表現不能 | 第 4 の形 `AUTHENTICATED` を追加 |
| b-3 | 共有シークレット方式が表現不能 | app-health-monitor の `x-monitor-token` 3 本、mail-gateway standalone の `COMPOSE_TOKEN` 1 本 | 第 5 の形にするか、policy-gate 対象外として明示的に除外リスト化 |
| b-4 | `INTERNAL` と `RequiredKeys` を**同時に**書けない | mail-automation 13 本が「内部専用かつ `mail:admin` 必須」。1 ルール 1 形なのでどちらかを捨てる | `internalOnly` を app レベル middleware として併用(表には鍵だけ書く) |
| b-5 | リソーススコープ(`resourceType`/`resourceId`)が渡せない | `PermissionGranter` のシグネチャに無い。event-service 12 本・gantt 5 本の event スコープが移行で失われる | スコープはハンドラ残しに降格するか、ポートを拡張 |
| b-6 | OR セマンティクスが無い(意図的) | member-service `requireAny(["identity:read","app:members:view"])` 3 本の意味が変わる | ロール実データを確認して片方に寄せる |

**アプリ追加が要るなら新規キーも要る**(下記 (c) と連動):
`app:github:view/edit`、`app:audit:view/edit`、`app:webhooks:view/edit` は現在**存在しない**。

### (c) APP_MANIFEST にアプリが無いサービス

APP_MANIFEST の id は 14 件(events / tasks / gantt / calendar / notifications / chat / mail /
usage / members / participation / driveshare / lp / admin / commander)。

| サービス | 状況 | 推奨 |
|---|---|---|
| **github-sync** | `github:*` 4 キーが**どのアプリにも claim されず** `policy.otherPermissions()` の「その他」に落ちる。ロール管理 UI で所属アプリ無しで表示される | appId `github` 新設 + `detailPermissions: ["github:read","github:write","github:sync","github:admin"]`。当面は素の `["github:read"]` 等で表現 |
| **audit-log** | `audit` エントリ無し。`appLevel("audit","view")` は `rule.ts` の `getApp` チェックで**モジュール読込時に throw** する | 素の `["audit:read"]` で書くか、manifest に追加 |
| **webhook-ingest** | `webhook:read` はあるが `app:webhooks:*` が無い | 素の `["webhook:read"]`(そもそも a-6 でルートが死んでいる) |
| **app-health-monitor** | エントリ無し(UI 面も無い) | 共有シークレット方式のまま、policy-gate 対象外 |
| auth-service / freeq-drain / mail-automation / drive-proxy / file-meta / api-gateway | UI アプリでないため不在は正当 | PUBLIC / INTERNAL / 素のキーで表現 |

### (d) 所有者チェック(ハンドラ側に残すもの)

リクエストのデータを見ないと決まらないため、**静的テーブルには載せられない**。
policy-gate の `gate.ts` ヘッダが明示する通り、これはドメイン層の責務。

| サービス | 判定 | 対象 |
|---|---|---|
| mail-gateway | `scopeOf` (`mail:read_all` の有無で全件/自分宛を切替) | `/mail/messages*` `/mail/sent*` `/mail/threads/:id` `/mail/scheduled`(GET) |
| mail-gateway | `ownerOf` (本人限定スコープ) | `/mail/flags*` `/mail/scheduled` 系 |
| mail-gateway | owner 一致 + `status='scheduled'` | `PATCH|DELETE /mail/scheduled/:id` |
| chat-service | `loadReadable` (visibility + membership) | channels / members / pins / read / ws-ticket / messages / reactions |
| chat-service | `ensureCanWrite` (public は自動参加、private は 403) | POST messages / pins / reactions |
| chat-service | `isChannelAdmin` (`member.role==="admin"` OR `chat:moderate`) | PATCH channel / POST members / DELETE member / DELETE message |
| chat-service | `authorId !== userId` -> 403 | `PATCH /chat/messages/:id` |
| chat-service | author OR moderator + 削除モードの tier 分岐 | `DELETE /chat/messages/:id` |
| notification | `getUserId(c)` の本人スコープ(パスに userId を含まない) | inbox / preferences 全ルート |
| notification | `isAdminViewer` (`notif:admin` を動的評価し admin audience 行の可視性を切替) | `GET /inbox` `/unread-count` |
| identity-roster | `id === requester` の自己参照例外 | `GET /identity/users/:id` |
| identity-roster | **LAST_ADMIN 不変条件**(最後の `identity:admin` を剥奪・無効化できない) | users/:id の PATCH / offboard / roles 付与剥奪 / roles PATCH |
| identity-roster | `source=email-routing` 行のみ論理無効化する所有権判定 | `POST /identity/users/sync-email-routing` |
| member-service | identity link を辿る自己行解決 | `GET|POST /members/internal/me/participation` |
| member-service | 呼び出し者の `identityUserId` から所属 teamIds を導出 | `GET /members/me/mention-teams` |
| member-service | 氏名・メール突合 + バージョン楽観ロック | `submitParticipation` / `resolveParticipation` |
| event-service | ボディの `phase` 遷移が admin 必須かを判定し `event:admin` を追加確認 | `PATCH /events/:id` |
| task-service | `includeArchived` で `task:delete` 追加要求 / `eventId` 省略時の自己スコープ | `GET /tasks` |
| task-service | `origin==="github"` の保護フィールドを非 service に拒否 / `origin` は service 限定 | `PATCH /tasks/:id` / `POST /tasks` |
| task-service | 同一チーム制約(cross-team の依存辺を拒否) | `PUT /tasks/:id/dependencies` |
| file-meta | `assertCanRead` (private は owner 一致 or `file:admin`) | `GET /files/meta/:id` `GET /files/:id/download` |
| file-meta | 結果セットごとの private フィルタ | `GET /files/search` |
| file-meta | `ownerId` 変更時のみ `file:admin`(ボディ依存) | `PATCH /files/meta/:id` |
| file-meta | **判定が抜けている**(`file:write` だけで他人の private を論理削除可) | `DELETE /files/meta/:id` — 追加すべき残し |
| auth-service | bearer/cookie の自己セッション検証 + 現行パスワード照合 | `POST /auth/password` |
| auth-service | roster allowlist / ドメインフィルタ / email・IP レート制限 | `POST /auth/password/login` |
| api-gateway | `auth.userId` をハンドラ内で上流パスに埋め込む(対象 id をクライアントから受けない) | `/me` 系 6 本 + `/bff/home` |
| webhook-ingest | body バイト列への暗号検証(HMAC / timing-safe token / OIDC JWT)。source ごとに検証器が異なる | `POST /hooks/:source` |
| commander-service | **所有者概念が実装に存在しない**(単独オペレータ前提・ADR 0003)。feature/task/run/chat に作成者カラムが無く owner チェックは**実装不可** | 複数ユーザー開放前にスキーマ追加が必要 |

---

## 4. 実装順の推奨と概算ルート数

### 4.1 フェーズ 0 — 着手前に片付ける(コード変更は最小)

**完了済み(`fb811d04`)**:

- ~~`INTERNAL` を `index.ts` から export~~ — 元から export 済み(b-1 は事実誤認)。
- ~~drive-share-service を参照実装として移行~~ — 完了。表・マウント・カバレッジテスト・
  `package.json` 依存の 4 点とも揃っている。

**残り**:

1. **`AUTHENTICATED` 形の追加**(b-2)。gateway `/me` 系と `POST /feedback` が表現できない。
2. **commander-service の穴(a-1)を塞ぐ**。未デプロイなので緊急ではないが、**deploy より先に**
   GET にもトークンガードを広げ、`cors` を絞り、両 toml に `workers_dev = false` を明記する。
3. 語彙で扱わないものを**明示的に除外リスト化**(b-3: 共有シークレット 4 本、DO/WS 4 本)。

### 4.2 フェーズ 1 以降 — 外部到達 × リスクの高い順

**順位 1(drive-share-service)は完了済み**。残作業は順位 2 以降。

| 順 | サービス | 概算ルート数 | 理由 |
|---|---|---|---|
| ~~1~~ | ~~drive-share-service~~ | 12 | **完了**(`fb811d04`)。参照実装として型と CI(`assertRouteCoverage`)を確立済み。以降のサービスはこの形を踏襲する |
| 2 | commander-service | 23 | 穴 a-1 が最大。ただし未デプロイで現状の露出は無いので「deploy 前に閉じる」位置づけ。所有者カラムが無く(d)、まず単独オペレータ前提のまま閉じる |
| 3 | api-gateway(所有ルート) | 12 | 最も露出した面。`/public/*`(a-2)と `/admin/users/:id/password` を含む |
| 4 | auth-service | 12 | `PUBLIC` が正解の典型例。a-3 の test/demo-login を明示的に表へ。条件付き登録のカバレッジ対応が要る |
| 5 | drive-proxy | 12 | a-5 のエッジ二重防御の欠落を同時に修正 |
| 6 | file-meta | 11 | `DELETE` の判定欠落(d)を同時に修正 |
| 7 | usage-meter / freeq-drain / audit-log | 5 / 3 / 5 | 小さく単純。`INTERNAL` の素振りに最適 |
| 8 | webhook-ingest | 5 | a-6 のデッドルートを先に直す |
| 9 | app-health-monitor | 5 | 共有シークレット方式のまま対象外にするか決める(a-7) |
| 10 | task-service | 12 | service principal 素通し(2.7 注)の呼び出し元洗い出しが前提 |
| 11 | gantt-service | 8 + WS 1 | a-4 の迂回を修正。event スコープ喪失(b-5)の判断が要る |
| 12 | event-service | 18 | スコープ喪失(b-5)の影響が最大。方針確定後に着手 |
| 13 | github-sync | 14 | アプリ追加(c)の判断が要る。素のキーなら単純 |
| 14 | deploy-service | 8 | `fresh` は保たれる(2.16 訂正)。subrequest 増の評価のみ |
| 15 | member-service | 20 | OR セマンティクス(b-6)でロール実データの確認が要る |
| 16 | mail-automation | 14 | `INTERNAL` + キーの併記問題(b-4)の解法確定後 |
| 17 | chat-service | 23 + DO 2 | ハンドラ残しが最多。表は単純だが回帰risk が高い |
| 18 | notification | 29(二重登録込) | 表が 2 系統要る。最後に |
| 19 | mail-gateway | 35 + standalone 3 | 最大。standalone Worker(b-3)の扱いを決めてから |
| 20 | identity-roster | 24 | **最後**。granter をインプロセス実装に差し替える特別対応(2.3)が要る |

**合計: 約 310 ルート**(22 サービス。WS/DO エントリ 4 本と非 HTTP エントリは除く)。

### 4.3 サービスごとの作業セット(共通)

各サービスで必要なのは次の 5 点。**drive-share-service で 5 点とも実施済み**なので、
以降のサービスは `services/drive-share-service/` を手本にすればよい:

1. `src/policy-table.ts` の新規作成(`definePolicyTable({...})`)
2. `app.ts` 冒頭での `app.use("*", policyGate({...}))` マウント
3. 既存の `requireAuth` / `requirePermission` / `requireAppAccess` / `requireAny` /
   inline `requireInternal` の**撤去**(二重認可を残さない)
4. `package.json` への `@dub/policy-gate` 依存追加
   (`"@dub/policy-gate": "workspace:*"`。現在入っているのは drive-share-service のみ)
5. `assertRouteCoverage(app, TABLE)` を呼ぶテスト 1 本(`test/policy-table.test.ts`)

### 4.4 共通の注意

- **`app.all()` は使用禁止**。Hono が `app.use()` と同一形式で記録するため、
  `routes.ts` の `isMiddlewareMount` がエンドポイントと区別できずゲートをすり抜ける
  (`routes.ts` に規約として明記済み・機械チェック不可)。
  現状 api-gateway の catch-all プロキシが `app.all("/api/v1/*")` を使っている。
- **subrequest 増**。`createAuthzGranter` はキャッシュを持たないため、
  全ゲート通過で identity への s2s が 1 回増える(1 ルール何キーでも 1 回)。
  無料枠の上限に対する評価が未実施 = **要確認**。
- `@dub/types` が policy-gate の `peerDependencies` にあるが、`rule.ts` は
  `policy` / `appRegistry` を**値として** import している。workspace 内では解決するが
  依存宣言としては `dependencies` が正しい = 要確認。

---

## 付録: 現状サマリ(基準コミット `fb811d04`)

| 指標 | 値 |
|---|---|
| サービス数 | 22 |
| 概算ルート数 | 約 310 |
| `@dub/policy-gate` 採用済みサービス | **1**(drive-share-service・参照実装) |
| 既存のポリシー表 | **1**(`services/drive-share-service/src/policy-table.ts`・12 ルート) |
| `assertRouteCoverage` テストがあるサービス | **1**(`services/drive-share-service/test/policy-table.test.ts`) |
| 未採用サービス | **21** |
| 外部到達かつ無認可のルート | 上記 a-2〜a-9(a-1 の commander 11 本は未デプロイのため現状は到達不可) |
| 新規に要る PermissionKey | **0**(アプリ追加を選べば `app:github:*` 等) |
| APP_MANIFEST 不在で `appLevel` 不可 | github-sync / audit-log / webhook-ingest / app-health-monitor |
| 語彙の不足 | **5 件**(b-2〜b-6。b-1 は事実誤認で欠落なし) |
