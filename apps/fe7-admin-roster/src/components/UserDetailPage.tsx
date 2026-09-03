// Secondary / deep-link screen (補助). Primary user management now happens INLINE on
// the roster right-pane (UserListPage) — design "1画面で完結". This standalone page is
// kept only so an existing `/admin/users/:id` deep link still resolves; it reuses the
// same UserInlineEditor so behaviour is identical to the inline pane.
import { PageHeader, ErrorState, EmptyState, SkeletonList } from "@dub/ui";
import { UserStatusBadge } from "./UserStatusBadge";
import { UserInlineEditor } from "./UserInlineEditor";
import { useUser } from "../hooks/useRosterApi";
import { presentError, displayError } from "../lib/errorDisplay";

export function UserDetailPage({
  userId,
  currentUserId,
  events = [],
}: {
  userId: string;
  currentUserId: string;
  events?: { id: string; name: string }[];
}) {
  const user = useUser(userId);

  if (user.isError) {
    const p = presentError(user.error);
    if (p.kind === "empty") return <EmptyState title={p.message} testId="fe7-user-notfound" />;
    return <ErrorState error={displayError(user.error)} onRetry={() => user.refetch()} testId="fe7-user-error" />;
  }
  // FE1 §5 loading principle: bare text ではなくスケルトンで「読み込み中」を示す。
  if (!user.data) return <SkeletonList rows={5} testId="fe7-user-detail-skeleton" />;

  return (
    <div>
      <PageHeader
        title={user.data.displayName}
        testId="fe7-user-header"
        actions={<UserStatusBadge status={user.data.status} testId="fe7-user-status" />}
      />
      <UserInlineEditor user={user.data} currentUserId={currentUserId} events={events} />
    </div>
  );
}
