# 0004. フェーズ状態機械を dub-core に永続化し、専用ワーカー(commander-service)でゲートする

- Status: Accepted
- Date: 2026-09-16
- Deciders: 高岡己太朗 (owner)

## Context

ADR 0002 でフェーズ FSM を純粋関数として実装した（段飛ばし=`illegal_transition`、
自己承認=`approval_required`）。ただし現フェーズ (基盤 PR#518) では `Feature` の状態は
どこにも永続化されておらず、daemon 内メモリの `Run`/`RunEvent` しか無い。進行管理を
実運用するには `Feature`/`Task`/`PhaseTransition` を永続化し、遷移ゲートをネットワーク越しに
呼べる API として提供する必要がある。

## Decision

1. **共有 D1 `dub-core` の `commander_` 名前空間に additive migration で永続化**する
   （`infra/d1/migrations/commander/0001_commander_init.sql`）。既存の集約マイグレーション
   基盤（`@dub/infra-d1` の `NAMESPACES` 登録 → `collectMigrations`/`applyAll`/lint）に
   そのまま乗せる。テーブル: `commander_features`（1 機能 = 1 行 = 台帳 1 エントリ）、
   `commander_tasks`、`commander_phase_transitions`（追記専用監査）、`commander_runs`、
   `commander_run_events`。
2. **CRUD + 遷移ゲートは専用ワーカー `commander-service`**（Hono, `services/commander-service`）が
   担う。daemon はローカル (loopback) の Node プロセスで dub-core (Cloudflare D1) に到達
   できないため、D1 バインドを持てるワーカーに置く。`POST /features/:id/transition` は
   FSM を通してから `Feature.phase` 更新と監査行 INSERT を行い、段飛ばし=409・自己承認=403 を返す。
3. **FSM は共有パッケージ `@dub/commander-phases` に抽出**し、daemon とワーカーが同一の遷移表を
   import する（二重定義禁止 [[dub-api-contract-sot]]）。daemon の `phases.ts` は re-export のみ。

## Alternatives Considered

1. **daemon が直接 D1 を叩く** — loopback の Node からリモート D1 への安全な直結は無く、
   認証/バインドの持ち回りが煩雑。却下。
2. **daemon にローカル SQLite を持たせる** — "dub-core に永続化" という要件（単一の真実源・
   他サービスと同じ台帳）を満たさない。却下。
3. **FSM を各所にコピー** — 遷移表の二重定義。ルール変更時に乖離する。却下。

## Consequences

- (+) フェーズ状態が dub-core の単一の真実源に載り、他サービス/将来のモバイルからも参照可能。
- (+) 遷移ゲートが HTTP API 化され、UI から段飛ばし/自己承認が構造的に不可能（409/403）。
- (+) 遷移表が 1 パッケージに集約され、変更は 1 箇所で済む。
- (−) commander-service は現状スキャフォールド（gateway 未接続・共有トークン認証は次フェーズ）。
  認証は `COMMANDER_OPERATOR_TOKEN` の任意ガードのみを先行実装（未設定なら開放）。
- (−) daemon の `start`（raw node）は `@dub/commander-phases` の dist を要するため、事前 build が必要
  （turbo `^build` が担保、README 追記済み）。
