// 参加届 form body (shared by the in-shell page and the public standalone page).
// 入力 → バリデーション → 送信 → サンクス。The submit goes to the PUBLIC endpoint, so the
// サンクス view is intentionally generic (no roster/member echo). 氏名 + 学校メール + Gmail
// are required (both emails must be a valid mail address); the rest is optional. The
// 希望チーム select is populated from the canonical team list when available (signed-in);
// when it can't be read (public/anonymous) the form still submits without a team.
import { useMemo, useState } from "react";
import { Button, Card, Form, FormField, TextField, Textarea, Select } from "@dub/ui";
import type { SelectOption } from "@dub/ui";
import { useParticipationTeams, useSubmitParticipation } from "./hooks.ts";
import {
  ACTIVITY_LABEL,
  DESIRED_ACTIVITIES,
  GRADE_LABEL,
  GRADES,
  type DesiredActivity,
  type Grade,
  type PublicParticipationResponse,
} from "./contracts.ts";
import styles from "./participation.module.css";

const GRADE_OPTIONS: SelectOption<Grade>[] = GRADES.map((g) => ({ value: g, label: GRADE_LABEL[g] }));
const ACTIVITY_OPTIONS: SelectOption<DesiredActivity>[] = DESIRED_ACTIVITIES.map((a) => ({
  value: a,
  label: ACTIVITY_LABEL[a],
}));

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const trimOrNull = (v: string): string | null => (v.trim().length > 0 ? v.trim() : null);

export function ParticipationForm(): JSX.Element {
  const teamsQuery = useParticipationTeams();
  const submit = useSubmitParticipation();

  const [name, setName] = useState("");
  const [schoolEmail, setSchoolEmail] = useState("");
  const [gmail, setGmail] = useState("");
  const [nameKana, setNameKana] = useState("");
  const [grade, setGrade] = useState<Grade | null>(null);
  const [department, setDepartment] = useState("");
  const [desiredTeamId, setDesiredTeamId] = useState<string | null>(null);
  const [desiredActivity, setDesiredActivity] = useState<DesiredActivity | null>(null);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ name?: string; schoolEmail?: string; gmail?: string }>({});
  const [done, setDone] = useState<PublicParticipationResponse | null>(null);

  const teams = teamsQuery.data?.teams ?? [];
  const teamOptions: SelectOption<string>[] = useMemo(
    () => teams.map((t) => ({ value: t.id, label: t.name })),
    [teams],
  );

  const onSubmit = () => {
    const next: { name?: string; schoolEmail?: string; gmail?: string } = {};
    if (name.trim().length === 0) next.name = "氏名を入力してください";
    if (schoolEmail.trim().length === 0) next.schoolEmail = "学校のメールアドレスを入力してください";
    else if (!EMAIL_RE.test(schoolEmail.trim())) next.schoolEmail = "メールアドレスの形式が正しくありません";
    if (gmail.trim().length === 0) next.gmail = "Gmail アドレスを入力してください";
    else if (!EMAIL_RE.test(gmail.trim())) next.gmail = "メールアドレスの形式が正しくありません";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    submit.mutate(
      {
        name: name.trim(),
        schoolEmail: schoolEmail.trim(),
        gmail: gmail.trim(),
        nameKana: trimOrNull(nameKana),
        grade,
        department: trimOrNull(department),
        desiredTeamId,
        desiredActivity,
        note: trimOrNull(note),
      },
      { onSuccess: (res) => setDone(res) },
    );
  };

  if (done) return <ThanksView result={done} onAgain={() => setDone(null)} />;

  return (
    <Card>
      <Form onSubmit={onSubmit}>
        <div className={styles.formStack}>
          <FormField label="氏名" htmlFor="p-name" required {...(errors.name ? { error: errors.name } : {})}>
            <TextField id="p-name" value={name} onChange={setName} testId="participation-name" placeholder="山田 太郎" />
          </FormField>
          <div className={styles.formRow}>
            <FormField
              label="学校のメールアドレス"
              htmlFor="p-school-email"
              required
              help="学校から配布されたアドレス"
              {...(errors.schoolEmail ? { error: errors.schoolEmail } : {})}
            >
              <TextField
                id="p-school-email"
                type="email"
                value={schoolEmail}
                onChange={setSchoolEmail}
                testId="participation-school-email"
                placeholder="you@school.ac.jp"
              />
            </FormField>
            <FormField
              label="Gmail アドレス"
              htmlFor="p-gmail"
              required
              help="連絡・共有に使う Gmail"
              {...(errors.gmail ? { error: errors.gmail } : {})}
            >
              <TextField
                id="p-gmail"
                type="email"
                value={gmail}
                onChange={setGmail}
                testId="participation-gmail"
                placeholder="you@gmail.com"
              />
            </FormField>
          </div>
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
  );
}

function ThanksView({ result, onAgain }: { result: PublicParticipationResponse; onAgain: () => void }): JSX.Element {
  const promoted = result.matchKind === "linked_existing";
  return (
    <div data-testid="participation-thanks">
      <Card>
        <div className={styles.thanksBody}>
          <p className={styles.thanksLead} aria-hidden>
            ✅
          </p>
          <p>
            参加届を受け付けました。ご提出ありがとうございます。
            {promoted ? "（登録済みの情報を更新しました）" : "（運営メンバー名簿に追加しました）"}
          </p>
          <Button variant="secondary" onClick={onAgain} testId="participation-again">
            続けて提出する
          </Button>
        </div>
      </Card>
    </div>
  );
}
