// Create / edit dialog for an 運営メンバー. Optimistic submit via the members hooks.
// 人物情報は参加届と共通の PersonProfileFields、運営固有の項目 (役割/ステータス/リーダー/
// チーム/連絡先) だけをこのダイアログで持つ。
import { useEffect, useMemo, useState } from "react";
import { Modal, Button, Form, FormField, TextField, Select, Checkbox } from "@dub/ui";
import type { SelectOption } from "@dub/ui";
import {
  PersonProfileFields,
  joinParts,
  parseProfileDraft,
  splitDisplayName,
  toProfileDraft,
  type PersonProfileErrors,
  type PersonProfileKey,
} from "../../lib/personProfile.tsx";
import { type MemberStatus, type MemberTeam, type OrgMember } from "./contracts.ts";
import { WRITE_STATUS_OPTIONS, toWriteStatus } from "./memberStatus.ts";
import { orgChartOrder, tierOf } from "./orgChartOrder.ts";
import { useCreateMember, useUpdateMember } from "./hooks.ts";
import styles from "./members.module.css";

const STATUS_OPTIONS: SelectOption<MemberStatus>[] = WRITE_STATUS_OPTIONS;
const NO_LEADER = "";
// 名簿は管理者が分かる範囲で登録するので、必須は苗字だけ (参加届より緩い)。
const REQUIRED: readonly PersonProfileKey[] = ["lastName"];

/** 編集時の初期値。姓/名 が無い旧データは表示名を分けて埋める。 */
function profileDraftOf(m: OrgMember | null) {
  const d = toProfileDraft(m);
  if (m && !m.lastName && !m.firstName) Object.assign(d, splitDisplayName(m.name));
  return d;
}

export function MemberFormDialog({
  open,
  onClose,
  teams,
  editing,
  members = [],
}: {
  open: boolean;
  onClose: () => void;
  teams: MemberTeam[];
  editing: OrgMember | null;
  /** 全メンバー(リーダー選択の候補に使う)。省略時はリーダー選択を出さない。 */
  members?: OrgMember[];
}): JSX.Element {
  const create = useCreateMember();
  const update = useUpdateMember();
  const [profile, setProfile] = useState(() => profileDraftOf(null));
  // 編集時は開いた時点の値と比べ、変えた項目だけを送る (推測で分けた姓/名や、旧ルールで
  // 入っていた値を触っていないのに上書き・検証しないため)。
  const [initialProfile, setInitialProfile] = useState(() => profileDraftOf(null));
  const [profileErrors, setProfileErrors] = useState<PersonProfileErrors>({});
  const [roleTitle, setRoleTitle] = useState("");
  const [status, setStatus] = useState<MemberStatus>("added");
  const [leaderId, setLeaderId] = useState<string>(NO_LEADER);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [contact, setContact] = useState("");

  useEffect(() => {
    if (!open) return;
    setProfile(profileDraftOf(editing));
    setInitialProfile(profileDraftOf(editing));
    setProfileErrors({});
    setRoleTitle(editing?.roleTitle ?? "");
    // 通常→"added"、打診系(invited/considering)→"invited" へ書き込み正準値を寄せる。
    setStatus(editing ? toWriteStatus(editing.status) : "added");
    setLeaderId(editing?.leaderId ?? NO_LEADER);
    setTeamIds(editing?.teamIds ?? []);
    setContact(editing?.contact ?? "");
  }, [open, editing]);

  const pending = create.isPending || update.isPending;

  // リーダー候補: 自分自身と辞退者を除外し、組織図順で並べる。役割段(tier)をラベルに添える。
  const leaderOptions: SelectOption<string>[] = useMemo(() => {
    const candidates = orgChartOrder(
      members.filter((m) => m.status !== "declined" && m.id !== editing?.id),
    );
    const tierLabel: Record<string, string> = { organizer: "オーガナイザー", leader: "リーダー", member: "メンバー" };
    return [
      { value: NO_LEADER, label: "なし（直属リーダーなし）" },
      ...candidates.map((m) => ({
        value: m.id,
        label: `${m.name}（${m.roleTitle ?? tierLabel[tierOf(m)]}）`,
      })),
    ];
  }, [members, editing?.id]);

  const toggleTeam = (id: string, checked: boolean) =>
    setTeamIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((t) => t !== id)));

  const submit = () => {
    const { profile: parsed, errors: allErrors } = parseProfileDraft(profile, REQUIRED);
    const changed = (k: PersonProfileKey) => !editing || profile[k] !== initialProfile[k];
    const errors = Object.fromEntries(
      Object.entries(allErrors).filter(([k]) => changed(k as PersonProfileKey)),
    ) as PersonProfileErrors;
    setProfileErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const profilePatch = Object.fromEntries(
      Object.entries(parsed).filter(([k]) => changed(k as PersonProfileKey)),
    ) as Partial<typeof parsed>;
    // 姓/名 はどちらかを変えたら組で送る (サーバは 姓/名 から表示名を合成する)。
    const nameChanged = changed("lastName") || changed("firstName");
    const payload = {
      ...profilePatch,
      ...(nameChanged
        ? { lastName: parsed.lastName, firstName: parsed.firstName, name: joinParts([parsed.lastName, parsed.firstName]) }
        : {}),
      roleTitle: roleTitle.trim() || null,
      status,
      leaderId: leaderId || null,
      teamIds,
      contact: contact.trim() || null,
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
          <div className={styles.formSectionTitle} data-testid="members-form-profile-section">
            本人の情報（参加届と同じ項目）
          </div>
          <PersonProfileFields
            draft={profile}
            onChange={setProfile}
            errors={profileErrors}
            required={REQUIRED}
            idPrefix="members-form"
          />
          <div className={styles.formSectionTitle}>運営での情報</div>
          <FormField label="担当・役割" htmlFor="member-role" help="例: 会場リーダー">
            <TextField id="member-role" value={roleTitle} onChange={setRoleTitle} />
          </FormField>
          <FormField label="ステータス" htmlFor="member-status" required help="通常メンバー（バッジなし）/ 打診中 / 休み中（一時離脱）/ 辞退。辞退にすると名簿一覧からは隠れます（データは残ります）。">
            <Select<MemberStatus>
              id="member-status"
              value={status}
              onChange={setStatus}
              options={STATUS_OPTIONS}
              testId="members-form-status"
            />
          </FormField>
          {members.length > 0 ? (
            <FormField label="リーダー（上長）" htmlFor="member-leader" help="この人が配下につくリーダーを選びます（任意）。組織図と名簿の並びに使われます。">
              <Select<string>
                id="member-leader"
                value={leaderId}
                onChange={setLeaderId}
                options={leaderOptions}
                testId="members-form-leader"
              />
            </FormField>
          ) : null}
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
          <FormField label="連絡先" htmlFor="member-contact" help="メール / Slack など">
            <TextField id="member-contact" value={contact} onChange={setContact} />
          </FormField>
        </div>
      </Form>
    </Modal>
  );
}
