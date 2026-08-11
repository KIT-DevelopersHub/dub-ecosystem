# Local Development Runbook

ローカル開発フローの正本は、リポジトリ直下の **[`LOCAL_DEV.md`](../../LOCAL_DEV.md)** に一本化した（`pnpm dev:seed` / `pnpm dev:<svc>` の実行可能なフロー・機能別の起動セット・fe2 の API ベース差し替え・通し確認・トラブルシュート）。ここでは要点だけ再掲する。

## 最短経路

```bash
pnpm install && pnpm build   # 契約パッケージを dist 出力
pnpm dev:seed                # ローカル D1(dub-core) に migration + デモ seed
# 必要な Worker だけ、ターミナル別に起動:
pnpm dev:identity   # :8790
pnpm dev:auth       # :8788  (ENVIRONMENT=local / DUB_TEST_LOGIN=1)
pnpm dev:gateway    # :8787  ← SPA / curl はここを叩く
pnpm dev:mail       # :8791  (MAIL_OUTBOUND_PROVIDER=mock・実送信なし)
```

- フロントだけ触るなら `VITE_DEMO=1 pnpm dev:fe2`（バックエンド不要・自動ログイン＋シード表示）。
- 起動対象は「検証対象＋その Service Binding 依存先」だけに絞る（非力 PC 配慮）。詳細な依存表・seed アカウント・通し確認 curl は `LOCAL_DEV.md` を参照。

## 型・テストの通し確認

```bash
pnpm typecheck   # turbo run typecheck（全パッケージ）
pnpm test        # turbo run test（vitest）
pnpm check       # typecheck + test
```

infra/d1 のスキーマを触ったら `cd infra/d1 && pnpm d1:lint && pnpm test` も通す。
