Feature: run の cancel / timeout
  暴走・ハングした claude を止められる。実行中の run を DELETE すると child を SIGTERM で
  kill して failed になり、理由を error イベントで先出しする。wall-clock timeout を超えた
  run も同様に kill されて failed になる。

  Scenario: 実行中の run を cancel すると failed で終わる
    Given daemon が低速 claude で起動している
    When Web からプロンプト "long running task" で run を開始する
    And 実行中に run を cancel する
    Then cancel は 202 で受理される
    And run は "failed" で終了する
    And error イベントに "cancelled" を含むメッセージが出る

  Scenario: timeout を超えた run は failed で終わる
    Given daemon が短い timeout かつ低速 claude で起動している
    When Web からプロンプト "long running task" で run を開始する
    Then run は "failed" で終了する
    And error イベントに "timed out" を含むメッセージが出る
