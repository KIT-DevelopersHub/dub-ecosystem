// UnsavedChangesGuard — confirm before an IN-APP (SPA) navigation would discard an
// unsaved form. Browser-level leaves (reload / tab close) are handled separately by
// useDraftAutosave's beforeunload, so this blocker disables its own beforeunload to
// avoid a double prompt. Mount it inside any route that owns a dirty form.
//
// A form using this guard is also rendered in isolation by unit tests (no router).
// useBlocker throws there, so we probe for a router first (useRouter returns null
// outside a RouterProvider) and only mount the blocker when one is present.
import { useBlocker, useRouter } from "@tanstack/react-router";
import { ConfirmDialog } from "@dub/ui";

export function UnsavedChangesGuard({ when, testId }: { when: boolean; testId?: string }): JSX.Element | null {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | null;
  if (!router) return null; // isolated render (tests) — nothing to block
  return <RouterLeaveGuard when={when} testId={testId} />;
}

function RouterLeaveGuard({ when, testId }: { when: boolean; testId?: string }): JSX.Element | null {
  const blocker = useBlocker({
    shouldBlockFn: () => when,
    enableBeforeUnload: false,
    withResolver: true,
  });
  if (blocker.status !== "blocked") return null;
  return (
    <ConfirmDialog
      open
      title="編集中の内容が保存されていません"
      message="このページを離れると入力中の内容は下書きとして保存されます。移動しますか？"
      confirmLabel="移動する"
      cancelLabel="編集を続ける"
      onConfirm={blocker.proceed}
      onCancel={blocker.reset}
      testId={testId}
    />
  );
}
