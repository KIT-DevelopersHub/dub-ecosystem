Feature: ローカル Claude Code を Web から駆動する（疎通）
  Commander の中核。Web からプロンプトを送ると、ローカルの exec ブリッジ（daemon）が
  claude を headless で実行し、ログが SSE でストリームされ、run が succeeded で終わる。

  Scenario: プロンプト送信 → claude 実行 → SSE ストリーム → succeeded
    Given daemon が起動している
    When Web からプロンプト "Reply with PONG" を送信する
    Then run はステータス "running" を経て "succeeded" になる
    And SSE で claude の結果 "PONG" が届く
    And exit コードは 0 である
    And run 履歴から同じ run を再取得できる
