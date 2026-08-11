// PermissionDenied (403). Shown when an authenticated user opens a route they
// lack the permission for. This is deliberately DISTINCT from NotFoundScreen (404):
// the page exists, the user simply is not authorized — so we say so and point them
// at an admin, instead of pretending the page is missing.
import { Button } from "@dub/ui";

export function PermissionDeniedScreen(): JSX.Element {
  return (
    <main data-testid="fe2-forbidden" className="fe2-center">
      <div className="fe2-center-inner">
        <span className="fe2-center-code">403</span>
        <h1 className="fe2-center-title">この機能の権限がありません</h1>
        <p className="fe2-center-sub">
          このページを開く権限が付与されていません。利用するには管理者にロール／権限の付与を依頼してください。
        </p>
        <a href="/">
          <Button variant="secondary">ホームへ戻る</Button>
        </a>
      </div>
    </main>
  );
}
