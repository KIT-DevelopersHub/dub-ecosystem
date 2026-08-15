// #1: link an 運営メンバー to its identity-roster login account. Shows name-match
// candidates (ranked, never auto-applied), the admin picks one and confirms. Optimistic
// via useLinkIdentity. Unlink is a one-click action on the row (handled by the caller).
import { useMemo, useState } from "react";
import { Modal, Button, TextField, Tag, SkeletonLoader, ErrorState } from "@dub/ui";
import type { identity } from "@dub/types";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useIdentityUsers, useLinkIdentity } from "./hooks.ts";
import { rankIdentityCandidates } from "./identityMatch.ts";
import type { OrgMember } from "./contracts.ts";
import styles from "./members.module.css";

export function LinkIdentityDialog({
  open,
  onClose,
  member,
  takenIds,
}: {
  open: boolean;
  onClose: () => void;
  member: OrgMember | null;
  /** identity userIds already linked to OTHER members (disabled in the picker). */
  takenIds: ReadonlySet<string>;
}): JSX.Element {
  const usersQuery = useIdentityUsers();
  const link = useLinkIdentity();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const users = usersQuery.data?.items ?? [];
  const ranked = useMemo(() => {
    const all = rankIdentityCandidates(member?.name ?? "", users, takenIds);
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((c) => c.user.displayName.toLowerCase().includes(q) || c.user.email.toLowerCase().includes(q));
  }, [member?.name, users, takenIds, search]);

  const confirm = () => {
    if (!member || !selected) return;
    link.mutate(
      { id: member.id, req: { identityUserId: selected, version: member.version } },
      { onSuccess: () => { setSelected(null); setSearch(""); onClose(); } },
    );
  };

  const close = () => { setSelected(null); setSearch(""); onClose(); };

  return (
    <Modal
      open={open}
      onClose={close}
      title={member ? `「${member.name}」をアカウントに紐付け` : "アカウントに紐付け"}
      testId="members-link-dialog"
      footer={
        <div className={styles.dialogFooter}>
          <Button variant="secondary" onClick={close} disabled={link.isPending}>キャンセル</Button>
          <Button variant="primary" onClick={confirm} loading={link.isPending} disabled={!selected} testId="members-link-confirm">
            紐付ける
          </Button>
        </div>
      }
    >
      <div className={styles.formStack}>
        <p style={{ color: "var(--dub-color-text-muted)", margin: 0 }}>
          名前が近いアカウントを上に表示しています。正しいアカウントを選んで「紐付ける」を押してください（自動では紐付けません）。
        </p>
        <TextField id="members-link-search" value={search} onChange={setSearch} placeholder="氏名・メールで絞り込み" testId="members-link-search" />

        {usersQuery.isLoading ? (
          <SkeletonLoader testId="members-link-loading" />
        ) : usersQuery.isError ? (
          <ErrorState
            error={ApiError.isApiError(usersQuery.error) ? toDisplayableError(usersQuery.error) : { code: "UNKNOWN", message: "アカウント一覧を取得できませんでした" }}
            onRetry={() => void usersQuery.refetch()}
          />
        ) : (
          <ul className={styles.linkCandidateList} data-testid="members-link-candidates">
            {ranked.map(({ user, score, taken }) => (
              <li key={user.id}>
                <button
                  type="button"
                  className={styles.linkCandidate}
                  aria-pressed={selected === user.id}
                  data-selected={selected === user.id}
                  disabled={taken}
                  onClick={() => setSelected(user.id)}
                  data-testid={`members-link-option-${user.id}`}
                >
                  <span className={styles.linkCandidateMain}>
                    <span className={styles.linkCandidateName}>{user.displayName}</span>
                    <span className={styles.linkCandidateEmail}>{user.email}</span>
                  </span>
                  <span style={{ display: "inline-flex", gap: "var(--dub-space-1)" }}>
                    {score >= 60 ? <Tag tone="success">候補</Tag> : null}
                    {taken ? <Tag tone="neutral">紐付け済み</Tag> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
