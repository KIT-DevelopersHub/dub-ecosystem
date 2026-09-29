Feature: run の永続化（daemon → commander-service → D1）
  daemon はループバック専用で D1 に直接届かない（ADR 0004）。COMMANDER_SERVICE_URL 設定時、
  run とその各イベントを commander-service に best-effort で永続化する。実行後に
  commander_runs / commander_run_events から run を再取得できる。

  Scenario: run 実行後に commander_runs / run_events に残り再取得できる
    Given commander-service が起動している
    And daemon が commander-service への永続化を有効にして起動している
    When Web からプロンプト "Reply with PONG" を送信する
    And run の完了を待つ
    Then commander-service から run を再取得できる
    And 永続化された run のステータスは "succeeded" である
    And 永続化された run のイベントに claude 結果 "PONG" が含まれる
