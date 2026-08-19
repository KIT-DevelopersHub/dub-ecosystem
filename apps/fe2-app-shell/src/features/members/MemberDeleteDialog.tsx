// 「メンバーを削除」= 論理削除(削除済み)の管理ダイアログ。運営メンバーを検索して
// 「削除」(=status deleted・組織図から消える)でき、「削除済み」セクションから
// 「在籍に戻す」で復帰もできる。物理削除はしない。楽観的UI＋admin fail-close(サーバ)。
import { useMemo, useState } from "react";
import { Modal, Button, TextField, Badge, EmptyState, ConfirmDialog } from "@dub/ui";
import type { OrgMember } from "./contracts.ts";
import { MemberStatusBadge } from "./MemberStatusBadge.tsx";
import { useSoftDeleteMember, useRestoreMember } from "./hooks.ts";
import styles from "./members.module.css";

export function MemberDeleteDialog({
  open,
  onClose,
  members,
}: {
  open: boolean;
  onClose: () => void;
  members: OrgMember[];
}): JSX.Element {
  const softDelete = useSoftDeleteMember();
  const restore = useRestoreMember();
  const [q, setQ] = useState("");
  // 削除は重い操作なので、実行前に確認ダイアログを必ず挟む（対象を明示）。復帰は非破壊なので即時。
  const [confirmTarget, setConfirmTarget] = useState<OrgMember | null>(null);
  const needle = q.trim().toLowerCase();
  const pending = softDelete.isPending || restore.isPending;

  const matches = (m: OrgMember): boolean =>
    !needle ||
    [m.name, m.roleTitle, m.department, m.grade].filter((v): v is string => !!v).some((v) => v.toLowerCase().includes(needle));

  const active = useMemo(() => members.filter((m) => m.status !== "deleted" && matches(m)), [members, needle]);
  const deleted = useMemo(() => members.filter((m) => m.status === "deleted" && matches(m)), [members, needle]);

  return (
    <Modal open={open} onClose={onClose} title="メンバーを削除 / 復帰" size="md" testId="members-delete-dialog">
      <div className={styles.deleteDialogBody}>
        <p className={styles.deleteDialogLead}>
          削除しても名簿から完全には消えず「<strong>削除済み</strong>」として残ります（組織図には表示されません）。あとから在籍に戻せます。
        </p>
        <TextField id="members-delete-search" value={q} onChange={setQ} placeholder="氏名・所属で検索" testId="members-delete-search" />

        <div className={styles.deleteSection}>
          <div className={styles.deleteSectionHead}>
            <span>運営メンバー</span>
            <Badge tone="neutral">{active.length}</Badge>
          </div>
          {active.length === 0 ? (
            <p className={styles.emptyTeamNote}>該当するメンバーがいません。</p>
          ) : (
            <ul className={styles.deleteList} data-testid="members-delete-active">
              {active.map((m) => (
                <li className={styles.deleteRow} key={m.id}>
                  <div className={styles.deleteInfo}>
                    <span className={styles.memberName}>{m.name}</span>
                    <MemberStatusBadge status={m.status} />
                    {m.department || m.grade ? (
                      <span className={styles.memberRole}>{[m.department, m.grade].filter(Boolean).join(" ")}</span>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={pending}
                    onClick={() => setConfirmTarget(m)}
                    testId={`members-delete-${m.id}`}
                  >
                    削除
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {deleted.length > 0 ? (
          <div className={styles.deleteSection}>
            <div className={styles.deleteSectionHead}>
              <span>削除済み</span>
              <Badge tone="neutral">{deleted.length}</Badge>
            </div>
            <ul className={styles.deleteList} data-testid="members-deleted-list">
              {deleted.map((m) => (
                <li className={styles.deleteRow} key={m.id}>
                  <div className={styles.deleteInfo}>
                    <span className={styles.memberNameMuted}>{m.name}</span>
                    <MemberStatusBadge status={m.status} testId={`members-deleted-badge-${m.id}`} />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={pending}
                    onClick={() => restore.mutate({ id: m.id, version: m.version })}
                    testId={`members-restore-${m.id}`}
                  >
                    在籍に戻す
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {members.length === 0 ? <EmptyState title="メンバーがいません" icon="users" /> : null}
      </div>
      <div className={styles.deleteDialogFooter}>
        <Button variant="secondary" onClick={onClose} testId="members-delete-close">
          閉じる
        </Button>
      </div>

      <ConfirmDialog
        open={confirmTarget !== null}
        title="メンバーを削除しますか？"
        message={
          confirmTarget
            ? `「${confirmTarget.name}」を削除済みにします（名簿には残り、組織図には表示されません）。あとで在籍に戻せます。`
            : ""
        }
        danger
        confirmLabel="削除済みにする"
        cancelLabel="キャンセル"
        onConfirm={() => {
          if (confirmTarget) softDelete.mutate({ id: confirmTarget.id, version: confirmTarget.version });
          setConfirmTarget(null);
        }}
        onCancel={() => setConfirmTarget(null)}
        testId="members-delete-confirm"
      />
    </Modal>
  );
}
