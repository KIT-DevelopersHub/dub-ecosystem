# 開発 lessons(Commander 専用・個人 memory から dev 部分のみ複製)

> 個人 memory のうち「Dub / dev エコシステム開発に関係する教訓」だけを複製。秘書運用・学業・
> 就活・カレンダー・メール・PII・他プロダクト固有の運用は除外。

## 検証・品質

- **Real browser E2E required**: UI 機能の完了報告には実ブラウザ E2E が必須。jsdom/grep の模擬
  検証は E2E ではない。
- **E2E gate before prod**: 本番反映は実ブラウザ E2E(production build)緑を確認してから。ローカル
  確認前の E2E は非同期で可。デプロイ後は本番 URL で描画を実測。
- **Bugfix include E2E**: バグ修正は根本原因 + 回帰 E2E/テストを green にしてから渡す。
- **Verify live, not just code**: 「どこにある/使えるか」はコード存在だけで断言せず、本番の有効化・
  表示を裏取りする。未確認なら状態を分けて正直に。
- **verify:live はマーカー grep だけで実挙動テストではない**。mock demo は永続を示せない。永続系は
  staging 実 backend で実ブラウザ往復必須。
- **E2E は別工程で非同期**: 実装エージェントは実ブラウザ E2E を同期で回さず速く返す。

## フロントエンド / UI

- **Design-system discipline**: フロントは `@dub/ui` 統一 + `@dub/tokens` + FRONTEND_GUIDE 規約。
  再利用性高く・UI をブレさせない・デザイナー視点必須。
- **Skeleton UI loading**: 読み込み中は必ずスケルトン UI(データ無しと区別)。
- **Optimistic UI**: 編集操作は楽観的 UI(先に反映 → 失敗時ロールバック)を原則に。
- **UI spacing**: 要素同士は十分な余白を取る(近接させ過ぎない)。`@dub/tokens` の spacing。
- **UI spec needs designer confirm**: 操作方法/レイアウトは実装で勝手に決めずデザイナー確認。

## アーキテクチャ / フロー

- **API contract SoT**: API 契約は単一の真実(共有スキーマ/型)+ CI で乖離検出。front/back(将来
  モバイルも)が同一契約から導出。二重定義禁止。変更時は相談。
- **Local-first PR loop**: 開発はローカル(前後端 dev)→ PR → CI → マージ → 本番はマイルストーンで。
  毎回本番直行しない。
- **Epic-branch workflow / bundled split-PR**: 複数タスクはエピックブランチで結合、PR はタスク毎に
  分割し統合 PR で束ねて main へ。
- **Demo base on current main**: demo は必ず現 origin/main 基点で作る。古い epic/feature 基点に
  しない(承認と main マージ後の挙動がズレる)。
- **App release-gating**: メンバー公開したアプリ以外は全員デフォルト off/グレーアウト。公開は
  デモ → 本番 → メンバー公開の 3 ステップ。admin は全アプリ可。

## 並行開発の安全

- **Remote check before PR**: 共有 repo は変更/PR 作成前に必ずリモート状態と他者の開き PR を確認して
  衝突回避。
- **Parallel worktrees fill disk**: 並行 subagent の git worktree が溜まるとディスク枯渇。使い終えたら
  `git worktree remove` で掃除。
- **Don't mass-delete during builds**: mass rm(node_modules 一括削除)を同一ツリーでビルド中の
  エージェントと並行しない(巻き込みで全滅する)。

## ゲート

- **No self-approval / phase gate**: フェーズ移行(demo→staging・staging→本番・`確認した`ラベル・
  本番マージ)はユーザー明示許可時のみ。自己承認・自己フェーズ移行を禁止。
- **Approval ship, no re-review**: 一度 OK したものは再確認を求めず本番まで。却下分だけ修正して再提出。
