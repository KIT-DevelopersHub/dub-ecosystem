Feature: 共有トークン認証
  daemon と commander-service はどちらも共有トークン（COMMANDER_OPERATOR_TOKEN）で守る。
  daemon は /health・/ 以外の全ルートで必須。service は GET も含む全ルートで必須
  （唯一の例外が /health）。未提示/不正は 401、正しいトークンで通過する。
  service はトークン未設定なら素通しではなく全ルート 503（fail-closed）。

  Scenario: daemon はトークン未提示だと 401、正しいトークンで通過する
    Given daemon がトークン "s3cret" 付きで起動している
    When トークンなしで run を作成しようとする
    Then daemon の HTTP ステータスは 401 である
    When トークン "s3cret" 付きで run を作成する
    Then daemon の HTTP ステータスは 201 である
    And トークン設定時でも daemon の /health は 200 で開いている

  Scenario: commander-service はトークン未提示だと読み書きともに 401、正しいトークンで通過する
    Given commander-service がトークン "s3cret" 付きで起動している
    When トークンなしで機能を作成しようとする
    Then service の HTTP ステータスは 401 である
    When トークン "s3cret" 付きで機能を作成する
    Then service の HTTP ステータスは 201 である
    And トークンなしで service の GET /features は 401 である
    And トークン "s3cret" 付きで service の GET /features は 200 である
    And トークン設定時でも service の /health は 200 で開いている
