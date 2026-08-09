// NotFound (design 2-1). Catch-all for unknown paths.
export function NotFoundScreen(): JSX.Element {
  return (
    <main data-testid="fe2-notfound">
      <h1>404</h1>
      <p>ページが見つかりませんでした。</p>
      <a href="/">ホームへ戻る</a>
    </main>
  );
}
