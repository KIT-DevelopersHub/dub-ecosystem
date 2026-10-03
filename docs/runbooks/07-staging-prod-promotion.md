# 07 — staging 反映 / 本番反映を 1 コマンドにする（`deploy:staging` / `ship:prod`）

> 結論: **staging 反映は `pnpm deploy:staging`、本番反映は `pnpm ship:prod`** の 2 コマンドに集約した。
> どちらも **デプロイ経路は従来どおり CI（`staging.yml` / `deploy.yml`）1 本のまま**で、スクリプトは
> 「PR 解決 → マーカー保証 → ラベル操作 → CI 待ち → `verify:live` 実測 → `deploy-state` 更新 → URL 出力」
> という**人手で抜けやすい手順だけ**を機械化する。`ship:prod` は既定で READ-ONLY（判定表を出すだけ）で、
> **`確認した` ラベルを自分では絶対に付けない**（自己承認の禁止）。

前提: [04-staging-label-gate.md](./04-staging-label-gate.md)（ラベル二重ゲート）・
[05-liveness-verification.md](./05-liveness-verification.md)（マーカー実測）・
[06-parallel-demo-staging-flow.md](./06-parallel-demo-staging-flow.md)（demo→承認→staging キュー）。

## 0. なぜ作ったか

demo 側は `deploy:demo:feature` → `staging:queue add` → `teardown:demo` と 1 コマンド化されていたが、
**その先（staging 反映・本番反映）にはコマンドが無かった**。手順書にはあるが実行は全部人手で、結果:

- ラベルだけ付けて CI の成否を誰も見ない → 失敗したまま「確認どうぞ」
- `verify:live` を飛ばす → 反映前 URL を確認に出す
- `deploy-state/staging.json` が古いまま → 今 staging に何が載っているか誰も分からない
- `staging:queue flush` が印字する手順の後半（PR 作成・ラベル・実測）が毎回ぶれる

## 1. staging へ反映する

```bash
# 現在のブランチの PR を staging へ（マーカーは PR 本文の Liveness-Marker: から自動取得）
pnpm deploy:staging

# PR 番号とマーカーを明示する場合
pnpm deploy:staging --pr 554 --markers 'data-testid="chat-send", 誤送信'

# 何もせず計画だけ見る
pnpm deploy:staging --pr 554 --markers '...' --dry-run
```

やること（1 コマンド）:

1. PR を解決（`--pr` → `--branch` → 現在のブランチ の順）。PR が無ければ中断（staging 反映は PR 経由のみ）。
2. マーカーを決定。`--markers` と PR 本文の `Liveness-Marker:` が**食い違っていれば中断**する
   （CI は本文を検証するため、割れると「CI 緑・手元の証跡は別物」になる）。本文に trailer が
   無ければ本文末尾に追記する。どちらも無ければ中断。
3. `stagingへ` ラベルを付与。すでに付いている場合は**一度外して付け直す**
   （`labeled` イベントは付いた瞬間しか発火しないため）。付け直しに失敗したら
   「ラベルが外れたまま」であることを明示して中断する。
4. その head SHA に対して**新しく作られた** `staging.yml` の run を待つ
   （赤／時間切れなら非ゼロ終了。上限は `PROMOTE_WAIT_MAX_MIN`、既定 45 分）。
5. `scripts/verify-live.sh staging <markers>` で**配信バンドル**にマーカー実在を実測。
6. `deploy-state/staging.json` を更新し、**`live=true` のときだけ** staging URL を出力する
   （実測前に URL を出さない＝「反映前 URL を確認に出す」を構造的に不可能にする）。

出力された URL と `live=true` の証跡が、そのまま確認依頼カードの必須項目になる（05 のチェックリスト）。
`deploy-state/staging.json` は**コミットする**（台帳が git と乖離すると次の `ship:prod` の SHA 照合が効かない）。

オプション: `--no-wait`（ラベル付与まで。URL は出さない）・`--note "<備考>"`。

### staging キューからのフラッシュと繋げる

```bash
pnpm staging:queue flush            # 統合ブランチへのマージ計画を印字＋台帳を flush
# 印字された git 手順を実行してから:
gh pr create --base main --head staging/demo-parity-integ --fill
pnpm deploy:staging --branch staging/demo-parity-integ --markers '<全機能のマーカー>'
```

## 2. 本番へ出す（既定は判定だけ）

```bash
pnpm ship:prod --pr 554              # ゲート判定表を出すだけ。何も変更しない
pnpm ship:prod --pr 554 --merge      # ゲート全通過時のみ: main マージ → deploy.yml → 本番実測
```

判定するゲート:

| 判定項目 | 通らない場合 |
|---|---|
| PR が open / draft でない | open・ready for review にする |
| コンフリクト無し（`mergeable`）・マージ状態が `DIRTY`/`BLOCKED` でない | main を取り込む・必須チェックを緑にする |
| `確認した` ラベルがある | **オーナーが staging で確認して付ける**。スクリプトは代理で付けない |
| `確認した` 付与より後にコミットが無い | 承認が古い。再度 staging 反映 → 確認し直してもらう |
| `deploy-state/staging.json` の `deployedSha` == PR の head SHA | 先に `pnpm deploy:staging`（staging に載っているのが別の版） |
| staging の配信物にマーカーが実在 | 同上 |

全通過で `READY`（exit 0）、1 つでも欠けると `NOT READY`（exit 10）。
`--merge` を付けた場合のみ: main へマージ（既定 squash）→ マージ commit の `deploy.yml` run を待つ →
`verify:live prod` で実測 → `deploy-state/prod.json` を更新（これもコミットする）。

**「確認した版そのものが本番に出る」ことの担保**は、ラベルの有無ではなく上の
「承認時刻 >= 最新コミット時刻」＋「staging の SHA == head SHA」の 2 点で行う。ラベルは PR に付く
恒久フラグなので、承認後に push すれば単独では簡単に古くなるため。

オプション: `--merge-method squash|merge|rebase`・`--no-wait`・`--markers`・
`--skip-staging-check "<理由>"`。

### `--skip-staging-check` は例外専用

**日常操作では使わない。** 既定が READ-ONLY なので、判定表を見たいだけなら `pnpm ship:prod --pr <n>` で足りる。
staging を別 PR が占有していて照合できない、といった例外時のみ、理由文字列を必須引数として渡す
（理由を書かせるのは、バイパスが常用化するのを防ぐため）。

### 注意: staging は main へのマージでも上書きされる

`staging.yml` は `push: main` でも staging を再デプロイする（本番との乖離防止のため）。
無関係な PR が main にマージされると、確認依頼に出した staging URL から機能が消え、
`ship:prod` の staging 実測も落ちる。その場合は `--skip-staging-check` に逃げず、
**`pnpm deploy:staging` で載せ直してから**判定する。

## 3. 自己承認の禁止（このコマンドの設計上の制約）

- `promote-prod.sh` には**ラベルを付与する経路が存在しない**。セルフテストが
  `promote-prod.sh` と `scripts/lib/promote-lib.sh` の両方を走査し、ラベル付与に使われうる
  呼び出し（`--add-label` / `issues/<n>/labels` / `gh label` 等）の不在を機械検査するので、
  後から生やすと CI（`scripts-selftest.yml`）が赤になる。
- 本番へ進める最後の一手は `--merge` を**明示したときだけ**。既定は READ-ONLY。
- `確認した` はオーナーの許可そのもの。エージェントは付けない・自作 PR を自己マージしない。
- **demo→staging の扱い**: `deploy:staging` は許可ゲートを持たない（＝自走可）。
  Commander の運用規約「実装・調査・demo/staging 反映までは自走可、本番へ進める最後の一手だけは
  常に許可待ち」に合わせた実装。

## 4. 検証

```bash
pnpm scripts:selftest                              # 全デプロイスクリプトのオフライン自己テスト（CI でも実行）
pnpm deploy:staging --pr <n> --markers '<m>' --dry-run
pnpm ship:prod --pr <n>                            # 判定表のみ（変更なし）
```

Exit code: `0` ok · `2` usage/不整合 · `1` 前提不足 · `3` not-live · `4` CI が赤/時間切れ ·
`5` CI run が作られなかった（トリガー未発火）· `10` ゲート未達。

## 関連

- 04 ラベル二重ゲート / 05 liveness 実測 / 06 並行 demo・staging キュー
- 実装: `scripts/promote-staging.sh`・`scripts/promote-prod.sh`・共通処理 `scripts/lib/promote-lib.sh`
- マーカー抽出は `scripts/lib/promote-lib.sh` の `marker_trailer()` と
  `.github/workflows/staging.yml` の liveness ステップで**同一**でなければならない（CRLF 対応含む）。
