# Runbooks

DevHub (Dub) エコシステムの運用手順書。**手順のみ** をまとめる（このディレクトリのドキュメントは実デプロイ・実行を行わない）。

現状（P0b 凍結）ではサービスは Worker スケルトンで、`database_id` や Service Binding 名は Apply 時に infra (#27/#28) が確定する。各手順書はその前提（`REPLACE_AT_DEPLOY` プレースホルダ、名前レジストリ未確定など）を明示する。

## 目次

| Runbook | 目的 |
|---|---|
| [01-deploy.md](./01-deploy.md) | 本番/preview デプロイ。CF トークン要件・D1 作成/migration・サービス依存順・Secret 一覧・スモーク |
| [02-local-dev.md](./02-local-dev.md) | ローカル開発。D1 reset/seed・各サービス起動・e2e スモーク |
| [03-oncall.md](./03-oncall.md) | オンコール/障害対応の初動。ログ・health/ready・レート制限 |
| [04-staging-label-gate.md](./04-staging-label-gate.md) | 3環境デプロイ。staging 全複製・「stagingへ」/「確認した」ラベル運用・二重ゲート・無料枠実数・カットオーバー |
| [05-liveness-verification.md](./05-liveness-verification.md) | 「確認して」の前に配信バンドルへ機能マーカー実在を機械検証。demo 直列化(`deploy:demo`)・`verify:live`・`deploy-state/` 台帳・staging CI liveness ゲート |

## 前提知識（3 runbook 共通）

- モノレポ: pnpm + turbo。ルートで `pnpm install`。Node >= 20。
- サービス実体: 16 Worker（`services/*`）+ mobile-bff（`apps/mo3-mobile-bff`）。外部公開は api-gateway (`api.developershub.jp`) と mobile-bff (`m-api.developershub.jp`) の 2 面のみ。他は Service Binding / Queue の内部 Worker。
- D1: 単一共有 DB `dub-core`（binding は全サービス共通の定数 `DB`）。各サービスは名前空間（`identity_*` 等）だけを所有する。
- 相関 ID: `x-dub-request-id`（wire フィールド `requestId`）。ログ突合の主キー。
