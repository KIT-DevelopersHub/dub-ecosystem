// Route transition indicator (design 2-2). Rendered while lazy routes resolve.
export function RouteLoadingBar({ active }: { active: boolean }): JSX.Element {
  return (
    <div
      role="progressbar"
      aria-hidden={!active}
      aria-label="ページを読み込み中"
      data-active={active}
      data-testid="fe2-route-loading"
    />
  );
}
