// Route error screen (design 2-1). Replaces TanStack Router's built-in bare
// "Something went wrong!" for any error thrown while a route renders.
//
// Primary job: recover from a stale hashed chunk after a deploy (the 通知 /
// メール名簿 が "Something went wrong" で開けない incident). When the failure is a
// failed dynamic import, we reload ONCE to pick up the fresh index.html + new
// chunk names — the same thing a manual refresh does, done automatically. The
// loop guard in reloadForStaleChunk() ensures we never reload-spin: if a reload
// does not resolve it, this screen stays visible with a manual retry.
import { useEffect } from "react";
import { Button } from "@dub/ui";
import { isChunkLoadError, reloadForStaleChunk } from "../../lib/chunkReload.ts";

export function RouteErrorScreen({ error }: { error?: unknown }): JSX.Element {
  const stale = isChunkLoadError(error);

  useEffect(() => {
    // Auto-recover stale chunks. If the guard suppresses the reload (already tried),
    // fall through and leave the manual retry visible.
    if (stale) reloadForStaleChunk();
  }, [stale]);

  if (stale) {
    return (
      <main data-testid="fe2-route-error-stale" className="fe2-center">
        <div className="fe2-center-inner">
          <h1 className="fe2-center-title">最新版を読み込んでいます…</h1>
          <p className="fe2-center-sub">
            アプリが更新されました。自動で再読み込みします。切り替わらない場合は下のボタンを押してください。
          </p>
          <Button testId="fe2-route-error-reload" onClick={() => window.location.reload()}>
            再読み込み
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main role="alert" data-testid="fe2-route-error" className="fe2-center">
      <div className="fe2-center-inner">
        <h1 className="fe2-center-title">問題が発生しました</h1>
        <p className="fe2-center-sub">
          ページの読み込み中にエラーが発生しました。時間をおいて再度お試しください。
        </p>
        <Button testId="fe2-route-error-retry" onClick={() => window.location.reload()}>
          再読み込み
        </Button>
      </div>
    </main>
  );
}
