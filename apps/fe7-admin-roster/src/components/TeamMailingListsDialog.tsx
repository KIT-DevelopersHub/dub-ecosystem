import { useState } from "react";
import type { mail, member } from "@dub/types";
import { Modal, TextField, Button, FormField, Select, SkeletonList, ErrorState, EmptyState, ConfirmDialog, type SelectOption } from "@dub/ui";
import { FormError } from "@dub/app-ui";
import { useCreateTeamList, useDeleteTeamList, useMembersOverview, useTeamLists } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { EMAIL_ROUTING_DOMAIN } from "../contracts/pending";
import { displayError, fieldErrorMap, presentError } from "../lib/errorDisplay";

// メーリングリスト: one @developershub.jp address per team. Membership is the team's roster, so
// there is nothing to maintain here; the row only shows how many people it reaches today.

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  padding: "12px 4px",
  borderBottom: "1px solid var(--dub-color-border, #d0d7de)",
};
const addrColStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
const addrStyle: React.CSSProperties = { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const metaStyle: React.CSSProperties = { color: "var(--dub-color-text-muted)", fontSize: "0.85em" };
const hintStyle: React.CSSProperties = { margin: "0 0 16px", color: "var(--dub-color-text-muted)", fontSize: "0.85em" };
const formStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 12, marginTop: 24 };
const suffixRow: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center" };
const suffixStyle: React.CSSProperties = { color: "var(--dub-color-text-muted)", whiteSpace: "nowrap" };
const actionsStyle: React.CSSProperties = { display: "flex", justifyContent: "flex-end" };

/** "デザインチーム・受信できる人 3 / 5 人": a member with no linked account gets nothing. */
function reachLabel(list: mail.MailTeamList, overview: member.MembersOverview | undefined): string {
  if (!overview) return "";
  const team = overview.teams.find((t) => t.id === list.teamId);
  if (!team) return "チームが見つかりません（このアドレス宛のメールは誰にも届きません）";
  const members = overview.members.filter((m) => m.teamIds.includes(team.id));
  const linked = members.filter((m) => m.identityUserId).length;
  return `${team.name}・受信できる人 ${linked} / ${members.length} 人`;
}

export function TeamMailingListsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lists = useTeamLists(open);
  const overview = useMembersOverview();
  const create = useCreateTeamList();
  const del = useDeleteTeamList();
  const { toast } = useToast();

  const [teamId, setTeamId] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<mail.MailTeamList | null>(null);

  const teams = overview.data?.teams ?? [];
  const usedTeams = new Set((lists.data?.items ?? []).map((l) => l.teamId));
  const teamOptions: SelectOption[] = teams.filter((t) => !usedTeams.has(t.id)).map((t) => ({ value: t.id, label: t.name }));

  function pickTeam(id: string) {
    setTeamId(id);
    const team = teams.find((t) => t.id === id);
    if (team) setLocalPart(team.key.toLowerCase());
  }

  function submit() {
    setFieldErrors({});
    setFormError(null);
    create.mutate(
      { localPart: localPart.trim(), teamId },
      {
        onSuccess: (list) => {
          toast({ kind: "success", title: "メーリングリストを作成しました", description: list.address });
          setTeamId("");
          setLocalPart("");
        },
        onError: (err) => {
          const p = presentError(err);
          if (p.kind === "field-errors") setFieldErrors(fieldErrorMap(p.fields));
          else if ("message" in p) setFormError(p.message);
        },
      },
    );
  }

  function confirmDelete() {
    const list = pendingDelete;
    setPendingDelete(null);
    if (!list) return;
    del.mutate(list.id, {
      onSuccess: () => toast({ kind: "success", title: "メーリングリストを削除しました", description: list.address }),
      onError: () => toast({ kind: "error", title: "削除に失敗しました", description: list.address }),
    });
  }

  const items = lists.data?.items ?? [];

  return (
    <Modal title="メーリングリスト" open={open} onClose={onClose} size="lg" testId="fe7-team-lists-dialog">
      <p style={hintStyle} data-testid="fe7-team-lists-hint">
        アドレス宛のメールは、チームのメンバー全員の Dub メール受信箱に届きます。メンバーの追加や削除はチームの名簿に自動で反映されます。Dub アカウント未連携の人と、メール閲覧権限のない人は読めません。
      </p>

      {lists.isLoading ? (
        <SkeletonList rows={3} testId="fe7-team-lists-loading" />
      ) : lists.isError ? (
        <ErrorState error={displayError(lists.error)} onRetry={() => lists.refetch()} testId="fe7-team-lists-error" />
      ) : items.length === 0 ? (
        <EmptyState title="メーリングリストはまだありません" testId="fe7-team-lists-empty" />
      ) : (
        <div data-testid="fe7-team-lists-list">
          {items.map((list) => (
            <div key={list.id} style={rowStyle} data-testid={`fe7-team-list-row-${list.id}`}>
              <span style={addrColStyle}>
                <span style={addrStyle}>{list.address}</span>
                <span style={metaStyle}>{reachLabel(list, overview.data)}</span>
              </span>
              <Button variant="danger" size="sm" onClick={() => setPendingDelete(list)} testId={`fe7-team-list-delete-${list.id}`}>
                削除
              </Button>
            </div>
          ))}
        </div>
      )}

      <div style={formStyle}>
        <FormField label="チーム" htmlFor="fe7-team-list-team" error={fieldErrors.teamId}>
          <Select
            id="fe7-team-list-team"
            value={teamId}
            options={teamOptions}
            placeholder="チームを選択"
            onChange={pickTeam}
            testId="fe7-team-list-team"
          />
        </FormField>
        <FormField label="アドレス" htmlFor="fe7-team-list-localpart" error={fieldErrors.localPart}>
          <div style={suffixRow}>
            <TextField id="fe7-team-list-localpart" value={localPart} onChange={setLocalPart} placeholder="design" testId="fe7-team-list-localpart" />
            <span style={suffixStyle}>@{EMAIL_ROUTING_DOMAIN}</span>
          </div>
        </FormField>
        <FormError>{formError}</FormError>
        <div style={actionsStyle}>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!teamId || !localPart.trim()} testId="fe7-team-list-submit">
            作成する
          </Button>
        </div>
      </div>

      <ConfirmDialog
        title="メーリングリストを削除"
        message={
          <span>
            <strong>{pendingDelete?.address}</strong> を削除します。
            <br />
            今後このアドレス宛のメールは届かなくなります。届いたメールは受信箱に残ります。
          </span>
        }
        open={pendingDelete !== null}
        danger
        confirmLabel="削除する"
        cancelLabel="キャンセル"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
        testId="fe7-team-list-delete-confirm"
      />
    </Modal>
  );
}
