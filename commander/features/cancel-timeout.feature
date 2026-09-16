Feature: run の cancel / timeout
  暴走・ハングした claude を止められる。実行中の run を DELETE すると child を SIGTERM で
  kill して failed になり、理由を error イベントで先出しする。timeout は「無音（stream-json の
  進捗が途切れた）が idle timeout 続いたら」だけ kill する idle watchdog 方式で、進捗が続く限り
  殺さない。既定は idle 30分・ハード上限 2時間（COMMANDER_RUN_IDLE_TIMEOUT_MS /
  COMMANDER_RUN_TIMEOUT_MS で上書き可）。

  Scenario: 実行中の run を cancel すると failed で終わる
    Given daemon が低速 claude で起動している
    When Web からプロンプト "long running task" で run を開始する
    And 実行中に run を cancel する
    Then cancel は 202 で受理される
    And run は "failed" で終了する
    And error イベントに "cancelled" を含むメッセージが出る

  Scenario: 無音が続いた run は idle timeout で failed になる
    Given daemon が短い idle timeout かつ低速 claude で起動している
    When Web からプロンプト "long running task" で run を開始する
    Then run は "failed" で終了する
    And error イベントに "(idle)" を含むメッセージが出る
