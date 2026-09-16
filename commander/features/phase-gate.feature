Feature: フェーズゲート（段飛ばし=409 / 自己承認=403）
  demo→staging→本番 のフェーズ遷移を commander-service が守る。許可されていない辺
  （段飛ばし）は 409、承認必須の辺を承認なしで進める（自己承認）は 403。承認付きだけが
  200 で遷移でき、監査ログに actor=user で追記される。@dub/commander-phases が単一の真実。

  Background:
    Given commander-service が起動している
    And "使用量ダッシュボード" という機能を作成する
    And 機能は phase "demo_building" で始まる
    And 機能を "demo_review" へ進める

  Scenario: 段飛ばし（demo_review → prod_shipped）は 409 で拒否され phase は不変
    When 機能を "prod_shipped" へ承認付きで進めようとする
    Then service の HTTP ステータスは 409 である
    And エラーコードは "illegal_transition" である
    And 機能の phase は "demo_review" のままである

  Scenario: 承認なしの承認必須遷移（demo_review → staging_deployed）は 403 で拒否され phase は不変
    When 機能を "staging_deployed" へ承認なしで進めようとする
    Then service の HTTP ステータスは 403 である
    And エラーコードは "approval_required" である
    And 機能の phase は "demo_review" のままである

  Scenario: 承認付きなら 200 で遷移し、監査ログに actor=user が追記される
    When 機能を "staging_deployed" へ承認付きで進める
    Then service の HTTP ステータスは 200 である
    And 機能の phase は "staging_deployed" になる
    And 監査ログの最新エントリは actor "user" かつ approvedByUser は true である
