// NotFound (design 2-1). Catch-all for unknown paths.
import { Button } from "@dub/ui";

export function NotFoundScreen(): JSX.Element {
  return (
    <main data-testid="fe2-notfound" className="fe2-center">
      <div className="fe2-center-inner">
        <span className="fe2-center-code">404</span>
        <h1 className="fe2-center-title">ページが見つかりませんでした</h1>
        <p className="fe2-center-sub">お探しのページは移動または削除された可能性があります。</p>
        <a href="/">
          <Button variant="secondary">ホームへ戻る</Button>
        </a>
      </div>
    </main>
  );
}
