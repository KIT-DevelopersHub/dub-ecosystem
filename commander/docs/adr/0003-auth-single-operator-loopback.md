# 0003. 認証は「単独オペレーター・ループバック限定」で始める

- Status: Accepted
- Date: 2026-09-16
- Deciders: 高岡己太朗 (owner)

## Context

Commander は **ユーザー本人しか使わない**。しかし daemon はローカルで `claude` を任意プロンプトで
spawn できるため、露出すると「誰でもそのマシンで Claude Code を実行できる」危険がある。基盤
フェーズでの認証方針を決める。

## Decision

daemon は **127.0.0.1（ループバック）にのみバインド**し、ネットワークに露出しない。

- `server.listen(port, "127.0.0.1")` 固定。LAN/公開インターフェースには出さない。
- CORS は許可（Dub ホストのフロントが loopback daemon を叩くため）だが、到達性自体が
  ローカルに限定されるため実効的な攻撃面は「同一マシンのプロセス」に閉じる。
- Dub 本体のログインは自前 email+password（[[dub-auth-self-hosted-primary]]）だが、
  Commander の daemon は**別レイヤ**であり、当面フロントの認証状態に依存しない。
- 将来、ローカルでも多重防御が要る場合は **共有トークン**（daemon 起動時に発行し、フロントが
  `Authorization` ヘッダで提示）を追加する。今は入れない（単独運用・過剰防御回避）。

## Alternatives Considered

1. **フル OAuth / セッション連携を最初から** — 単独運用には過剰。基盤 PoC を遅らせる。却下。
2. **0.0.0.0 バインド + トークン** — 露出面を増やす。今は不要。将来必要時に loopback+token へ。
3. **OS ユーザー権限のみに委ねる** — loopback バインドと組み合わせれば十分（同一マシン前提）。

## Consequences

- (+) 最小構成で安全側（外部からの到達不可）。PoC を素早く回せる。
- (+) secrets を持たない（[[secrets-stay-local]] と整合）。daemon はステートレスに近い。
- (−) リモートから使えない（設計どおり。必要なら Cloudflare Tunnel + token を将来検討）。
- (−) 同一マシン上の別プロセスからは叩ける。単独運用マシン前提で許容。トークン化で将来強化可能。
