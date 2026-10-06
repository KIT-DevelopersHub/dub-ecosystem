# dub-ecosystem — リポジトリ規約（Claude / コントリビューター向け）

## デプロイ通知（重要）: PR 本文の1行目に「通知文言」を書く

本番デプロイが完了すると、CI がその変更を **全メンバーの通知（Admin inbox）** に1件記録する。
その通知の見出しは **PR 本文の1行目（「通知文言」欄）** から採られる。生の PR タイトルや
コミット件名（`fix(db): …` などの開発者向け文字列）はユーザーには出さない。

したがって **この repo で PR を作成するときは、必ず次に従う**:

1. `.github/PULL_REQUEST_TEMPLATE.md` の先頭「通知文言（ユーザー向け・1行）」に、
   **「何ができるようになったか」をユーザー目線で1行** 書く。
   - 良い例: `使用量ダッシュボードを全メンバーに開放しました`
   - 悪い例: `feat(usage): add usage dashboard route`（開発用語で伝わらない）
2. 開発者向けの背景・設計説明は、テンプレート下部の「変更内容（開発者向け）」に書く
   （そこは通知には出ない）。
3. `docs` / `chore` / `ci` / `build` / `test` / `style` / `deps` など **メンバーに無関係な
   変更** は、通知文言を空のままにしてよい。その場合そのデプロイは通知されない
   （逆に通知文言を書けば、type に関わらず通知される = オプトイン）。

### 仕組み（実装の所在）

- コピー生成: `infra/d1/src/deployCopy.ts`
  （`extractNotifyLine` = PR 本文から1行目を抽出 / `buildDeployCopy` = 通知文言優先で見出し生成 /
  `isPresentableNotifyLine` = 日本語・非プレースホルダ判定）。
- 通知行生成 + スキップ判定: `infra/d1/src/adminNotify.ts`
  （`buildDeployNotifyRow` / `shouldNotifyDeploy` / `mergedPrToMeta`）。
- CI スクリプト: `infra/d1/scripts/admin-notify.ts`（前向き・PR body を GitHub API から取得）、
  `infra/d1/scripts/admin-notify-backfill.ts`（過去 PR の取り込み）。

優先順位は **通知文言（人間が書いた1行） → タイトルの機械整形 → 種別ごとの汎用文言**。
1行目が空/規約外（英語のみ・プレースホルダ）なら自動でフォールバックするので、後方互換は保たれる。

## 認可（重要）: 新しい API を追加する時は policy-table.ts に1行足す

**結論: `services/<svc>/src/` にルートを1本足したら、同じコミットで
`services/<svc>/src/policy-table.ts` にもそのルートの行を足す。** 認可はハンドラにも
middleware にも書かない。表が唯一の真実源で、`policyGate`（`app.ts` の先頭で1回マウント）
だけが判定する。

足し忘れは黙って通らない。二重に落ちる:

- **実行時**: 表に無いルートは `policyGate` が **403**（fail-closed）。穴が開くのではなく
  機能が動かなくなる。
- **CI**: 各サービスの `test/policy-table.test.ts` の `assertRouteCoverage` が
  「ルーターの登録ルート集合」と「表のキー集合」を**両方向**で比較して赤くなる
  （足りない = ルール漏れ / 余っている = typo か消し忘れ）。

手本は `services/drive-share-service/`（表・マウント・テストの3点が揃った参照実装）。

### 1. 表の書き方

キーは **`"METHOD /path"`**。パスは**ルーターに登録したパターンそのまま**（`:id` 等を含む・
URL ではない）。値は次の **5形のみ**で、語彙は閉じている（6番目を作るのは設計変更）。

```ts
export const POLICY_TABLE = definePolicyTable({
  "GET /things": appLevel("things", "view"),
  "POST /things": appLevel("things", "edit", "things:write"),
  "GET /things/me": AUTHENTICATED,
  "GET /internal/health": INTERNAL,
  "PATCH /internal/sync": internalWithKeys(["things:admin"]),
  "POST /webhooks/stripe": PUBLIC,
});
```

| 形 | 意味 |
|---|---|
| `[key, ...]` / `appLevel(app, level)` | そのキーを**全部**持つ発信者のみ（連言・OR は無い） |
| `internalWithKeys([...])` | s2s マーカー **かつ** 全キー |
| `INTERNAL` | Service Binding 経由の s2s のみ（`x-dub-internal`） |
| `AUTHENTICATED` | ログイン済みなら誰でも・キー不要 |
| `PUBLIC` | 未認証の公開インターネットから呼ばれてよい |

**判断順**: まず `appLevel(...)`/明示キーを疑う（通常はこれ）→ 外から到達しないなら
`INTERNAL`（s2s かつキーも要るなら `internalWithKeys`）→ セッション本人だけを扱う
`/me` 形なら `AUTHENTICATED` → 本当に公開したいものだけ `PUBLIC`。

**各形の「これが誤りになる時」は `packages/policy-gate/src/rule.ts` に書いてある。
最初の3形以外を選ぶ前に必ず読む**（ここでは繰り返さない）。

### 2. やってはいけないこと（実際に事故った形）

- **`app.all()` を使わない**。Hono は `app.all()` を `app.use()` と同一形式（method ALL）で
  記録するので、`isMiddlewareMount` がエンドポイントと区別できず、**ゲートもカバレッジ
  テストも素通りする**＝全部緑のままで無認可ルートが出荷できる唯一の経路。`.get` / `.post`
  等の具体メソッドで登録する。
- **exact path の `app.use("/x", mw)` を使わない**。Hono は `ALL /x` として記録し、
  `isMiddlewareMount` はワイルドカード（`*` / `.../*`）しか mount と見ないので、
  存在しないルートについてカバレッジが赤くなる。per-route middleware
  （`app.get("/x", mw, handler)`）にする。**`isMiddlewareMount` を緩めて直すのは禁止**
  ——裸パスまで mount 扱いにすると `app.all("/x", h)` が素通りするようになり、
  赤いビルドを静かな穴に交換することになる。
- **ハンドラ・middleware に認可を書かない**。`requireAuth` / `requirePermission` /
  `requireAppAccess` / `requireAny` / 手書きの `x-dub-internal` チェックは全て撤去済み。
  再導入しない（二重認可は、次のルートで忘れる側が必ず残る）。
- **`AUTHENTICATED` を「緩くしたい」理由で使わない**。これはセッション本人しか対象に
  できない `/me` 形専用。「403 がうるさい」は**ロール側の問題**で、表で緩めるとその
  ルートが永久にロール管理の外に出る。死活監視も `PUBLIC` ではなく `INTERNAL`。
- **`appLevel(app, "edit")` を要求する前に、そのロールが実際に `app:<id>:edit` を
  持っているか `infra/d1/migrations/identity/*.sql` で確認する**。`0008_per_app_access.sql`
  では `role_sys_member` / `role_sys_organizer` は多くのアプリで **`:view` だけ**。
  確認せず `edit` を要求すると「一般メンバーがその機能を使えなくなる」
  （chat / notification で実際に起きた）。緩めるのは**表ではなくロール管理側**。

### 3. 2層構成: キー検査は表・インスタンス判定はハンドラ

表は**静的**（method + ルートパターン → キー）。リクエストの**データ**を見ないと決まらない
ものは表の仕事ではない。

- **表（1層目）** = 「この発信者はそのキーを**そもそも**持っているか」（型レベル。例 `event:read`）
- **ハンドラ（2層目）** = 「それが**この**リソースに適用されるか」（インスタンスレベル。
  例 event X の所有者か）。行を既に読み込んだ場所で assert し、ハンドラ自身のテストで守る。

`PermissionGranter` が `resourceId` を取らないのは意図的（取れるようにすると全ルールが
リクエストの関数になり、表がコードに戻る）。**旧ガードが `resourceId` を渡していた
ルートは、表の行と同じコミットでハンドラ側の assert を書く**。これを落とすと
event スコープのチェックが黙って org 全体に広がる＝退行。

### 4. 新規サービスを作る時の5点セット

1. `src/policy-table.ts` を作る（`definePolicyTable({...})` で全ルートを宣言）
2. `app.ts` の**先頭**で `app.use("*", policyGate({ service, table, granted }))`
3. 旧 middleware（`requireAuth` 等）を**置かない / 撤去する**
4. `package.json` の `dependencies` に `"@dub/policy-gate": "workspace:*"`
5. `test/policy-table.test.ts` で `assertRouteCoverage(app, TABLE)` を呼ぶ

この5点は `packages/policy-gate/test/service-adoption.test.ts` が **リポジトリ横断で
機械チェック**している。サービスを足して何もしないと**このテストが赤くなる**。
ゲートが判定材料を持てないサービス（共有シークレットの門など。`app-health-monitor` と
`commander-service` が該当）だけは同ファイルの `NOT_GATED` に**理由付きで**登録して除外し、
代わりに同等の3点（表・fail-closed なゲート・カバレッジテスト）を自前の語彙で用意する
（`services/commander-service/src/protection-table.ts` が手本）。

### 仕組み（実装の所在）

- 語彙5形とそれぞれの「これが誤りになる時」: `packages/policy-gate/src/rule.ts`（規約の正典）
- 2層構成（表 = キー検査 / ハンドラ = インスタンス判定）: `packages/policy-gate/src/gate.ts` ヘッダ
- ルート識別と `app.all()` 禁止の理由: `packages/policy-gate/src/routes.ts`（`isMiddlewareMount`）
- カバレッジ検査: `packages/policy-gate/src/coverage.ts`（`assertRouteCoverage`）
- 横断 CI ガードと除外リスト: `packages/policy-gate/test/service-adoption.test.ts`
- 移行の経緯・サービス別の棚卸し・除外判断の基準: `docs/policy-coverage-inventory.md`
  （4.3 作業セット / 4.4 共通の注意 / (e) 除外リスト）
