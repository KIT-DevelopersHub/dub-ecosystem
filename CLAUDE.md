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
