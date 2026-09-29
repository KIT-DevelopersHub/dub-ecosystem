Feature: 共有トークン認証
  daemon と commander-service はどちらも共有トークン（COMMANDER_OPERATOR_TOKEN）で守れる。
  トークン設定時、daemon は /health・/ 以外の全ルートで、service は POST（変更系）で必須。
  未提示/不正は 401、正しいトークンで通過する。

  Scenario: daemon はトークン未提示だと 401、正しいトークンで通過する
    Given daemon がトークン "s3cret" 付きで起動している
    When トークンなしで run を作成しようとする
    Then daemon の HTTP ステータスは 401 である
    When トークン "s3cret" 付きで run を作成する
    Then daemon の HTTP ステータスは 201 である
    And トークン設定時でも daemon の /health は 200 で開いている

  Scenario: commander-service はトークン未提示だと POST が 401、正しいトークンで通過する
    Given commander-service がトークン "s3cret" 付きで起動している
    When トークンなしで機能を作成しようとする
    Then service の HTTP ステータスは 401 である
    When トークン "s3cret" 付きで機能を作成する
    Then service の HTTP ステータスは 201 である
    And トークン設定時でも service の GET /features は 200 で開いている
