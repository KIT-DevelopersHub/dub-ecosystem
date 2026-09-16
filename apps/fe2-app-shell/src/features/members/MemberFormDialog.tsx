// Create / edit dialog for an 運営メンバー. Optimistic submit via the members hooks.
import { useEffect, useState } from "react";
import { Modal, Button, Form, FormField, TextField, Textarea, Select, Checkbox } from "@dub/ui";
import type { SelectOption } from "@dub/ui";
import { MEMBER_STATUSES, type MemberStatus, type MemberTeam, type OrgMember } from "./contracts.ts";
import { STATUS_LABEL } from "./MemberStatusBadge.tsx";
import { useCreateMember, useUpdateMember } from "./hooks.ts";
import styles from "./members.module.css";

// 「削除済み」は作成/編集フォームでは選ばせない（削除は専用の「メンバーを削除」アクション経由）。
const STATUS_OPTIONS: SelectOption<MemberStatus>[] = MEMBER_STATUSES.filter((s) => s !== "deleted").map((s) => ({
  value: s,
  label: STATUS_LABEL[s],
}));

export function MemberFormDialog({
  open,
  onClose,
  teams,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  teams: MemberTeam[];
  editing: OrgMember | null;
}): JSX.Element {
  const create = useCreateMember();
  const update = useUpdateMember();
  const [name, setName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [status, setStatus] = useState<MemberStatus>("considering");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [department, setDepartment] = useState("");
  const [grade, setGrade] = useState("");
  const [contact, setContact] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(editing?.name ?? "");
    setRoleTitle(editing?.roleTitle ?? "");
    setStatus(editing?.status ?? "considering");
    setTeamIds(editing?.teamIds ?? []);
    setDepartment(editing?.department ?? "");
    setGrade(editing?.grade ?? "");
    setContact(editing?.contact ?? "");
    setNote(editing?.note ?? "");
  }, [open, editing]);

  const pending = create.isPending || update.isPending;

  const toggleTeam = (id: string, checked: boolean) =>
    setTeamIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((t) => t !== id)));

  const submit = () => {
    if (name.trim().length === 0) {
      setError("氏名を入力してください");
      return;
    }
    const payload = {
      name: name.trim(),
      roleTitle: roleTitle.trim() || null,
      status,
      teamIds,
      department: department.trim() || null,
      grade: grade.trim() || null,
      contact: contact.trim() || null,
      note: note.trim() || null,
    };
    const done = () => onClose();
    if (editing) {
      update.mutate({ id: editing.id, patch: { ...payload, version: editing.version } }, { onSuccess: done });
    } else {
      create.mutate(payload, { onSuccess: done });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "メンバーを編集" : "メンバーを追加"}
      testId="members-form-dialog"
      footer={
        <div className={styles.dialogFooter}>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} testId="members-form-submit">
            {editing ? "保存" : "追加"}
          </Button>
        </div>
      }
    >
      <Form onSubmit={submit}>
        <div className={styles.formStack}>
          <FormField label="氏名" htmlFor="member-name" required {...(error ? { error } : {})}>
            <TextField id="member-name" value={name} onChange={setName} testId="members-form-name" />
          </FormField>
          <FormField label="担当・役割" htmlFor="member-role" help="例: 会場リーダー">
            <TextField id="member-role" value={roleTitle} onChange={setRoleTitle} />
          </FormField>
          <FormField label="学科" htmlFor="member-department" help="任意 (例: 情報工学科)">
            <TextField id="member-department" value={department} onChange={setDepartment} testId="members-form-department" />
          </FormField>
          <FormField label="学年" htmlFor="member-grade" help="任意 (例: 3年 / M1)">
            <TextField id="member-grade" value={grade} onChange={setGrade} testId="members-form-grade" />
          </FormField>
          <FormField label="ステータス" htmlFor="member-status" required>
            <Select<MemberStatus>
              id="member-status"
              value={status}
              onChange={setStatus}
              options={STATUS_OPTIONS}
              testId="members-form-status"
            />
          </FormField>
          <FormField label="所属チーム" htmlFor="member-teams" help="複数選択できます">
            {teams.length === 0 ? (
              <p className={styles.emptyTeamNote}>先にチームを追加してください</p>
            ) : (
              <div className={styles.teamCheckList} id="member-teams">
                {teams.map((t) => (
                  <Checkbox
                    key={t.id}
                    id={`member-team-${t.id}`}
                    checked={teamIds.includes(t.id)}
                    onChange={(c) => toggleTeam(t.id, c)}
                    label={t.name}
                  />
                ))}
              </div>
            )}
          </FormField>
          <FormField label="連絡先" htmlFor="member-contact" help="任意 (メール / Slack など)">
            <TextField id="member-contact" value={contact} onChange={setContact} />
          </FormField>
          <FormField label="メモ" htmlFor="member-note">
            <Textarea id="member-note" value={note} onChange={setNote} rows={3} />
          </FormField>
        </div>
      </Form>
    </Modal>
  );
}
