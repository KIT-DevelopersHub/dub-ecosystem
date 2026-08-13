// 参加届 screen: 入力 → バリデーション → 送信 → サンクス。A signed-in 運営 files their
// own 参加届; on success member-service reflects it onto the roster (招待中→追加済, or
// a new 追加済 member) and the サンクス view reports which happened. The 希望チーム select
// is populated from the canonical team list; if it can't be read the form still submits
// without a team.
import { useMemo, useState } from "react";
import { PageHeader, Button, Card, Form, FormField, TextField, Textarea, Select } from "@dub/ui";
import type { SelectOption } from "@dub/ui";
import { useParticipationTeams, useSubmitParticipation } from "./hooks.ts";
import {
  ACTIVITY_LABEL,
  DESIRED_ACTIVITIES,
  GRADE_LABEL,
  GRADES,
  type DesiredActivity,
  type Grade,
  type SubmitParticipationResponse,
} from "./contracts.ts";
import styles from "./participation.module.css";

const GRADE_OPTIONS: SelectOption<Grade>[] = GRADES.map((g) => ({ value: g, label: GRADE_LABEL[g] }));
const ACTIVITY_OPTIONS: SelectOption<DesiredActivity>[] = DESIRED_ACTIVITIES.map((a) => ({
  value: a,
  label: ACTIVITY_LABEL[a],
}));

const trimOrNull = (v: string): string | null => (v.trim().length > 0 ? v.trim() : null);

export function ParticipationPage(): JSX.Element {
  const teamsQuery = useParticipationTeams();
  const submit = useSubmitParticipation();

  const [name, setName] = useState("");
  const [nameKana, setNameKana] = useState("");
  const [grade, setGrade] = useState<Grade | null>(null);
  const [department, setDepartment] = useState("");
  const [contact, setContact] = useState("");
  const [desiredTeamId, setDesiredTeamId] = useState<string | null>(null);
  const [desiredActivity, setDesiredActivity] = useState<DesiredActivity | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SubmitParticipationResponse | null>(null);

  const teams = teamsQuery.data?.teams ?? [];
  const teamOptions: SelectOption<string>[] = useMemo(
    () => teams.map((t) => ({ value: t.id, label: t.name })),
    [teams],
  );

  const onSubmit = () => {
    if (name.trim().length === 0) {
      setError("氏名を入力してください");
      return;
    }
    setError(null);
    submit.mutate(
      {
        name: name.trim(),
        nameKana: trimOrNull(nameKana),
        grade,
        department: trimOrNull(department),
        contact: trimOrNull(contact),
        desiredTeamId,
        desiredActivity,
        note: trimOrNull(note),
      },
      { onSuccess: (res) => setDone(res) },
    );
  };

  if (done) return <ThanksView result={done} onAgain={() => setDone(null)} />;

  return (
    <div data-testid="participation-page">
      <PageHeader
        title="参加届"
        description="運営メンバーとして参加する届出です。送信すると運営メンバー名簿に反映されます。"
      />
      <Card>
        <Form onSubmit={onSubmit}>
          <div className={styles.formStack}>
            <FormField label="氏名" htmlFor="p-name" required {...(error ? { error } : {})}>
              <TextField id="p-name" value={name} onChange={setName} testId="participation-name" placeholder="山田 太郎" />
            </FormField>
            <FormField label="ふりがな" htmlFor="p-kana" help="全角かな / カナ">
              <TextField id="p-kana" value={nameKana} onChange={setNameKana} placeholder="やまだ たろう" />
            </FormField>
            <div className={styles.formRow}>
              <FormField label="学年" htmlFor="p-grade">
                <Select<Grade>
                  id="p-grade"
                  value={grade}
                  onChange={setGrade}
                  options={GRADE_OPTIONS}
                  placeholder="選択してください"
                  testId="participation-grade"
                />
              </FormField>
              <FormField label="学科" htmlFor="p-dept">
                <TextField id="p-dept" value={department} onChange={setDepartment} placeholder="情報工学科" />
              </FormField>
            </div>
            <FormField label="連絡先" htmlFor="p-contact" help="メール / Slack など (任意)">
              <TextField id="p-contact" type="email" value={contact} onChange={setContact} placeholder="you@example.com" />
            </FormField>
            <FormField
              label="希望チーム"
              htmlFor="p-team"
              help={teams.length === 0 ? "チーム未取得のまま送信できます" : "参加したい班を選べます (任意)"}
            >
              <Select<string>
                id="p-team"
                value={desiredTeamId}
                onChange={setDesiredTeamId}
                options={teamOptions}
                placeholder="選択してください"
                disabled={teams.length === 0}
                testId="participation-team"
              />
            </FormField>
            <FormField label="希望する活動" htmlFor="p-activity">
              <Select<DesiredActivity>
                id="p-activity"
                value={desiredActivity}
                onChange={setDesiredActivity}
                options={ACTIVITY_OPTIONS}
                placeholder="選択してください"
                testId="participation-activity"
              />
            </FormField>
            <FormField label="その他" htmlFor="p-note" help="連絡事項など (任意)">
              <Textarea id="p-note" value={note} onChange={setNote} rows={3} />
            </FormField>
            <div className={styles.actions}>
              <Button variant="primary" onClick={onSubmit} loading={submit.isPending} testId="participation-submit">
                参加届を送信
              </Button>
            </div>
          </div>
        </Form>
      </Card>
    </div>
  );
}

function ThanksView({ result, onAgain }: { result: SubmitParticipationResponse; onAgain: () => void }): JSX.Element {
  const promoted = result.matchKind === "linked_existing";
  return (
    <div data-testid="participation-thanks">
      <PageHeader title="参加届を受け付けました" description="ご提出ありがとうございます。" />
      <Card>
        <div className={styles.thanksBody}>
          <p className={styles.thanksLead} aria-hidden>
            ✅
          </p>
          <p>
            <strong>{result.member.name}</strong> さんを運営メンバー名簿に
            {promoted ? "反映（招待中 → 追加済）しました。" : "新しく追加しました。"}
          </p>
          <Button variant="secondary" onClick={onAgain} testId="participation-again">
            続けて提出する
          </Button>
        </div>
      </Card>
    </div>
  );
}
