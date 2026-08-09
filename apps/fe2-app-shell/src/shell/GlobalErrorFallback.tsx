// Global error fallback (design 2-2). Last-resort UI when a route/render throws.
import { Button, Icon } from "@dub/ui";

export function GlobalErrorFallback({
  error,
  onReset,
}: {
  error?: unknown;
  onReset?: () => void;
}): JSX.Element {
  const message = error instanceof Error ? error.message : "予期しないエラーが発生しました。";
  return (
    <div role="alert" data-testid="fe2-error-fallback">
      <Icon name="alert-triangle" />
      <h1>問題が発生しました</h1>
      <p>{message}</p>
      {onReset ? (
        <Button testId="fe2-error-retry" onClick={onReset}>
          再読み込み
        </Button>
      ) : null}
    </div>
  );
}
