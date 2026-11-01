# Dub エコシステム 開発フロー(Commander 専用・dev 部分のみ)

> 個人 `~/.claude/rules/dub-development-flow.md` の **開発フロー部分だけ**を複製したもの。
> 判断キュー/起票運用は除外。目的=「demo で却下したのに staging に進む」「staging に進んだ
> のに demo 確認一覧に残る」「同じ機能が 2-3 個に分裂して両方の確認に入る」の再発防止。

## 0. 基本フロー
1. タスク(追加機能/修正)を受ける
2. 実装 → **demo にデプロイ**
3. demo 確認 → OK / 却下
4. OK のものだけ **staging 反映**
5. staging 確認 → OK / 却下
6. OK のものだけ **本番反映**(`確認した`ラベル → main マージ → 自動 prod)

> **例外: Commander アプリ自身**は demo / staging / `確認した`を省略して一気に本番まで出す
> (下記 §8)。それ以外の全アプリはこの順を厳守する。

## 1. 単一フィーチャー台帳(Single Source of Truth)
- **1 機能 = 1 エントリ**。機能はフェーズを **1 つだけ**持つ。
- 機能を触るたびに**必ず台帳を先に検索**し、既存があれば**そのエントリを更新**。新規行を作らない。
- 判断カード/PR/エージェントも **1 機能につき 1 つ**。既存があれば流用・更新。

## 2. フェーズは排他
- demo 確認一覧と staging 確認一覧に**同時に居ない**。
- demo 確認 OK → staging に進んだら **demo 一覧から必ず消す**。両方に残さない。
- staging 却下 → demo に戻す時は staging 一覧から消して demo に戻す。**常にどちらか一方だけ**。

## 3. 却下の扱い
- demo で**却下**された内容は **staging へ絶対に進めない**。修正して demo に再反映 → 再確認。
- staging へ進める前に **「staging 版 == demo で OK した版」かを diff / 実ブラウザで照合**。
  demo で見た状態と違うものを staging に載せない(=demo 承認済みコードを正典にする)。

## 4. demo=staging 一致(統合ブランチ方式)
- demo 承認済み機能を統合したブランチを staging へ一括反映し、staging が demo と 1:1 一致を保つ。
- 新たに demo 承認された機能はクリーン PR を統合ブランチにマージして再デプロイ。

## 5. 本番反映 / 自己承認の禁止(最重要)
- 各機能 PR は **staging 確認 OK** 後に `確認した`ラベル(オーナー)→ main マージ → 自動 prod。
- 一度 OK したものは再確認を求めず本番まで。却下分だけ修正して再提出。
- **フェーズ移行(demo→staging・staging→本番・`確認した`ラベル付与・本番マージ・本番デプロイ
  起動)はユーザーが明示許可した時のみ**。自己承認・勝手なフェーズ移行を禁止。自作 PR の自己
  マージや `確認した`ラベルの自己適用をしない。**本番へ進める最後の一手だけは常に許可待ち**。
- **`確認した`はオーナーだけが付ける**。エージェントはどの経路(`gh pr edit --add-label`・`gh api`・
  GraphQL・ラベル改名)でも絶対に付けない。「ユーザーが本番 OK と言った」場合でも付けるのは
  オーナー本人。エージェントは `これに付けて: <PR URL>` を書いて待つ。
- **指示された段で止まる**。「staging に進んで」= staging 反映 + verify:live + 確認依頼まで。
  main マージ・本番デプロイには進まない。「本番に進んで」でも PR に `確認した`が無ければ
  マージせず `これに付けて:` を書いて止まる。
- 本番は **main マージ → deploy.yml の自動デプロイだけ**。`--admin` マージ・main 直 push・
  `gh workflow run deploy.yml`・手元からの本番 `wrangler deploy` は禁止(ラベルゲートの迂回になる)。
  out-of-band 本番反映はしない。
- 上記は `hooks/prod-gate-guard.mjs`(PreToolUse)と CI(prod-gate.yml / deploy.yml)の二重で
  機械的に止める。ブロックされたら迂回策を探さず止まって報告する。

## 5.1 `確認した`ラベルは 1 タスク 1 本に絞る
- `確認した`が要るのは **main 向け PR だけ**(prod-gate.yml)。1 タスクで **main 向け PR は 1 本だけ**
  にする。分割 PR はその 1 本のブランチ向けに積み、ラベル不要にする。作り直しで不要になった
  main 向け PR は close する。
- ラベルを付けてほしい時(staging 確認依頼など)は、最終報告に **`これに付けて: <PR URL>` を 1 行**
  書く。URL は 1 つだけ。ラベル不要な段階(demo 確認など)では書かない。
- Commander はこの行の PR をタスクの PR として扱う(ボードの「PR を開く」の行き先)。

## 6. 作業前チェックリスト
- [ ] 台帳でこの機能の既存エントリ/現フェーズを確認したか
- [ ] 同じ機能の既存カード/PR/エージェントが無いか(重複を作らない)
- [ ] demo 却下中の内容を staging に混ぜていないか
- [ ] フェーズが進んだら前の確認一覧から消したか
- [ ] staging に載せるのは demo 承認済みの版そのものか

## 7. 並行開発の環境フロー(demo 個別複製 + staging 5 件キュー)
- **demo = 機能ごとの使い捨て環境**。base=現 origin/main にその 1 機能だけマージした専用 demo を
  作り URL を渡す。**1 demo 1 機能**。確認(OK/却下)が付いたら必ず teardown。demo は
  frontend+mock/seed(VITE_DEMO)で実 backend を叩かない構成に限る(無料枠を圧迫しない)。
- **demo デプロイは `pnpm deploy:demo --markers "<機能固有マーカー>"` のみ**。デプロイ後に
  `pnpm verify:live demo "<マーカー>"` で配信物にマーカーが実在すること(反映)を実測してから
  URL を渡す。反映実測の証跡が無い確認依頼は出さない。
- **staging = キュー方式**。demo で OK が 5 件溜まったらまとめて staging にマージ → 最終確認。
  フラッシュ条件: (a)5 件到達 / (b)最後の demo 承認から一定期間経過 / (c)ユーザー指示。
- **backend 実往復が要る機能**(D1 往復・実 API 等)は **staging(実 backend)で必ず実確認**。
  demo(mock/seed)は「見た目/挙動」まで。demo OK だけで本番に出さない。
- **demo は必ず現 origin/main 基点で作る**。古い epic/feature branch 基点にしない
  (承認した挙動と main マージ後の挙動がズレる事故を防ぐ)。実装前に
  `git fetch && git worktree add <dir> origin/main` で最新 main から枝を切る。
- **「確認して」は live URL 必須**。同じ委譲の中で demo/staging 反映 + verify:live まで含める。
  verify:live PASS の live URL が無い確認カードは出さない。
- UI/機能 PR は本文に `Liveness-Marker: <文字列>` を記入(staging CI が配信バンドルを自動検証)。

## 8. Commander 自身の開発(一気に本番・オーナー決定 2026-10-18)
- Commander アプリ**だけ**を変えるタスクは demo / staging / `確認した`を省略し、実装 → PR →
  main マージ → deploy.yml の自動本番まで**エージェントが自走してよい**。型/テスト/ビルド green と
  セルフレビューは省略しない。
- 判定は `scripts/commander-only-pr.sh <PR番号>`(CI と hook が同じものを使う)。対象 =
  `commander/`・`services/commander-service/`・`packages/commander-phases/`・
  `apps/fe2-app-shell/src/features/commander/` のみを触る PR。
- 次を 1 つでも触る PR は Commander のタスクでも通常フロー(`確認した`必須):
  他アプリのファイル / `commander/.claude-home/`(規約・hook・settings)/ `infra/d1/migrations/` /
  `scripts/` / `.github/`。ゲート自体をエージェントが緩められないようにするため。
- Commander の PR に他アプリの変更を混ぜない(混ぜると例外が外れて通常フローになる)。
- 本番反映後、daemon / web を動かしているローカル checkout を更新し `restart.sh` で再起動して
  反映を確認する。
