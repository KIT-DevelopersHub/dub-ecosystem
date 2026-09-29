Feature: Dub アプリランチャー統合（管理者限定・メンバー未公開）
  Commander は Dub の 1 アプリとして APP_MANIFEST に登録され、識別ドメインの管理者アプリ
  として /commander に出る。閲覧は app:commander:view、モジュールは identity:admin を要求。
  リリースゲート上は未公開（PUBLISHED_APPS に無い）ので、一般メンバーにはグレーアウトされ、
  管理者だけがタイルを開ける。

  Scenario: Commander は管理者アプリとして登録されている
    Then アプリ "commander" は登録されている
    And アプリ "commander" の navPath は "/commander" である
    And アプリ "commander" の閲覧には権限 "app:commander:view" が必要である
    And アプリ "commander" は identity:admin を要求する

  Scenario: 管理者はランチャーで Commander タイルを開ける
    Given 管理者の閲覧者
    Then 管理者にとって Commander はリリースゲートで塞がれない

  Scenario: 一般メンバーには Commander が未公開（グレーアウト）である
    Given 一般メンバーの閲覧者
    Then アプリ "commander" は公開アプリ一覧に含まれない
    And 一般メンバーにとって Commander はリリースゲートで塞がれる
