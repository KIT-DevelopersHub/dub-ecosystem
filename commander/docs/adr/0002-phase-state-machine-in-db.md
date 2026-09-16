# 0002. 進行管理はフェーズ状態機械として DB 化し、段飛ばし・自己承認をコードで禁止する

- Status: Accepted
- Date: 2026-09-16
- Deciders: 高岡己太朗 (owner)

## Context

現在の進行管理は `~/.claude/rules/dub-development-flow.md` と `Dub_フィーチャー台帳` の
人手運用で支えられ、「タスク漏れ」「demo で却下したのに staging/本番へ進む段飛ばし」
「自己承認によるフェーズ移行」を構造的に防げない。Commander の中核価値はここを仕組みで塞ぐこと。

## Decision

各フィーチャーの進行を **有限状態機械 (FSM)** としてモデル化し、**遷移表を単一の真実**とする。

- フェーズ: `demo_building → demo_review → (demo_rejected) → staging_deployed → staging_review
  → (staging_rejected) → prod_shipped`。
- **許可された辺のみ**を遷移表に定義し、それ以外は `illegal_transition` として拒否
  （= 段飛ばし禁止）。
- フェーズを進める辺（demo 承認→staging、staging 承認→本番）には `requiresApproval: true` を付け、
  `approvedByUser: true` が無い遷移は `approval_required` で拒否（= 自己承認禁止・
  [[no-self-approval-phase-gate]]）。
- 却下は承認不要の辺で rework（`*_rejected → demo_building`）に戻す。
- コアは **純粋関数**（I/O なし）として実装（`commander/daemon/src/phases.ts`）。UI/永続層は
  現フェーズを保存し、遷移のたびに `transition()` を呼ぶ。永続スキーマは data-model.md 参照。

## Alternatives Considered

1. **文字列 status を自由更新** — 現状と同じ。段飛ばし・自己承認を防げない。却下。
2. **ワークフローエンジン（Temporal 等）導入** — 過剰。非力 PC 制約に反し、単独運用には重い。
3. **UI 側だけでガード** — バイパス可能。ガードは実行層（daemon/DB）に置くべき。

## Consequences

- (+) 段飛ばし・自己承認が型と実行時ガードの両方で不可能になる（テストで担保）。
- (+) 遷移表が唯一の真実になり、ルール変更は 1 箇所の編集で済む。
- (+) 純粋関数なのでテストが速く決定的（`phases.test.ts` で happy path・段飛ばし・
  承認欠如・却下・終端を検証）。
- (−) フェーズ定義の変更には遷移表の更新とマイグレーションが必要（意図的な摩擦＝安全側）。
- 次フェーズで、この FSM を DB（フィーチャー台帳のスキーマ化）と UI ゲートに接続する。
