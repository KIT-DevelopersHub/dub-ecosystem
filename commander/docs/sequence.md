# Commander — Sequence Diagrams

## 1. 疎通 PoC: Web → daemon → claude headless → log → Web

現 PoC で実測済みのフロー（`POST /runs` → SSE → `claude -p` → stream-json → 中継 → 完了）。

```mermaid
sequenceDiagram
  autonumber
  actor U as ユーザー
  participant W as Commander Web (SPA)
  participant D as commander-daemon (loopback)
  participant C as claude -p (headless)

  U->>W: プロンプト入力 → Run
  W->>D: POST /runs { prompt }
  D->>C: spawn claude -p --output-format stream-json --verbose
  D-->>W: 201 { runId, status: running }
  W->>D: GET /runs/:id/events (EventSource, SSE)
  D-->>W: event: status running (バッファ replay)
  loop stdout 1 行ごと
    C-->>D: stream-json オブジェクト (system/assistant/result...)
    D-->>W: event: claude { data }
  end
  C-->>D: close (exit code)
  D-->>W: event: exit { code }
  D-->>W: event: status succeeded|failed
  D-->>W: SSE close
  W-->>U: ログ表示 + 最終ステータス
```

## 2. フェーズ移行（次フェーズ・状態機械ゲート）

demo 承認→staging のように **承認必須**の遷移は、ユーザーの明示承認が無いと弾かれる。

```mermaid
sequenceDiagram
  autonumber
  actor U as ユーザー
  participant W as Commander Web
  participant D as daemon / API
  participant FSM as phases.transition()
  participant DB as D1 (Feature/PhaseTransition)

  U->>W: 「demo 承認」操作
  W->>D: POST /features/:id/transition { to: staging_deployed, approvedByUser: true }
  D->>FSM: transition(from, to, { approvedByUser: true })
  alt 許可された辺 かつ 承認あり
    FSM-->>D: to
    D->>DB: Feature.phase 更新 + PhaseTransition 追記
    D-->>W: 200 { phase: staging_deployed }
  else 段飛ばし
    FSM-->>D: PhaseTransitionError(illegal_transition)
    D-->>W: 409 段飛ばし禁止
  else 承認なし
    FSM-->>D: PhaseTransitionError(approval_required)
    D-->>W: 403 自己承認禁止
  end
```
