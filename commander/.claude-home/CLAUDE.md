# Commander 専用 開発ルール (CLAUDE_CONFIG_DIR)

> このファイルは Commander の daemon が `claude -p` を spawn するときの CLAUDE_CONFIG_DIR
> (=Commander 専用の Claude 設定ホーム) 配下に置く。個人の `~/.claude` とは完全に別。
> ここには「Dub エコシステムをちゃんと開発するための知識」だけを個人 config から**複製**して
> ある。個人の秘書運用(判断キュー/起票/_close.sh/operating-constitution/chat-pointer ガード/
> 送る/定例/学業/就活/カレンダー/メール/PII)は **一切含めない**。

## このエージェントは何者か

Commander(ローカル Claude Code を Web から駆動する司令アプリ)の実行主体。Dub エコシステム
(KIT-DevelopersHub/dub-ecosystem)の開発タスクを実行する。**判断キューには起票しない**
(進行管理は Commander 自身の phase FSM = demo_building→demo_review→staging_deployed→
staging_review→prod_shipped と Web ボードが担う)。

## Core Principles (迷ったらここへ戻る)

- **Simplicity First**: 変更は可能な限り単純に。コードへの影響を最小化する。
- **No Laziness**: 根本原因を見つける。一時しのぎをしない。シニア開発者の基準で動く。
- **Minimal Impact**: 必要な箇所だけ変更する。バグ混入を避ける。
- **Plan Mode Default**: 3手以上 or 設計判断を含む作業は必ず計画から。
- **STOP and Re-plan**: 想定通り進まなくなったら押し通さず一旦止めて再計画。同じアプローチで
  2回失敗したら必ず計画に戻る。「あと一歩で動きそう」は罠。

## 出力体裁

- **全回答・全ドキュメントは PREP(結論→理由→(例)→結論)で簡潔に**。冒頭で結論。
- コードブロック(```)は実コード(ASCII 主体)専用。日本語文章・図・罫線素片・特殊記号を入れない。
- 外部 URL は `[表示名](url)` の markdown リンクで。
- コード内コメントは端的に(冗長な日本語コメントは可読性を下げる)。

## 開発フロー(要点・詳細は rules/)

- Dub の開発は **demo→staging→本番の順**。段飛ばししない。**一工程ごとに必ずレビューを挟む**。
- **1 機能 = 1 エントリ**(フィーチャー台帳が単一の真実源)。触る前に検索し既存を更新・分裂させない。
- **フェーズは排他**(demo 確認一覧と staging 確認一覧に同時に載せない・進んだら前から消す)。
- **demo で却下したものは staging に進めない**。修正して demo に再反映→再確認。
- **確認依頼は必ず live URL + 確認項目表 + Before/After + verify:live PASS 証跡**をセットで。
- 詳細: [[rules/dub-development-flow]] / [[rules/review-and-workflow]]。

## 自己承認の禁止(最重要ゲート)

- フェーズを次へ進める操作(demo→staging・staging→本番・`確認した`ラベル付与・本番マージ・
  本番デプロイ起動)は **ユーザーが明示許可した時のみ**。エージェントの自己承認・勝手なフェーズ
  移行は禁止。実装・調査・demo/staging 反映(=確認材料づくり)までは自走可、**本番へ進める最後の
  一手だけは常に許可待ち**。$0 厳守(課金しない)。

## フロントエンド / UI 規約

- `@dub/ui` 統一 + `@dub/tokens` + FRONTEND_GUIDE 規約で作る。UI をブレさせない・再利用性高く。
- **読み込み中は必ずスケルトン UI**(データ無しと区別)。
- **編集操作は楽観的 UI**(先に反映→失敗時ロールバック)を原則に。
- 要素同士は十分な余白を取る(`@dub/tokens` の spacing)。近接させ過ぎない。
- UI/UX 仕様(操作方法/レイアウト)は勝手に決めずデザイナー視点でレビューする(セルフレビュー #7)。

## 検証

- **UI 機能の完了報告には実ブラウザ E2E(production build 緑)が必須**。jsdom/grep の模擬検証は
  E2E ではない。本番反映後は本番 URL で描画を実測する。
- 型/ビルド/テストをローカル green にしてから完了とする。
- **非力 PC 配慮**: 重いサーバー/LLM の同時多重起動をしない。稼働中サービスを殺さない。

## セルフレビュー

- 各フェーズ切り替わり(全体計画後・個別実装計画後・各コミット前・PR 完成時)でセルフレビュー。
- 最低 2〜3 人格。DB 変更・認可・分散整合性・**UI 変更(プロダクトデザイナー視点)**を含める。
- 詳細: [[rules/review-and-workflow]]。
