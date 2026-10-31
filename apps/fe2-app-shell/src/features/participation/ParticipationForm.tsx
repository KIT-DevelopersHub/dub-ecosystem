// 参加届 form body (shared by the in-shell page and the public standalone page).
// 入力 → バリデーション → 送信 → サンクス。The submit goes to the PUBLIC endpoint, so the
// サンクス view is intentionally generic (no roster/member echo). 氏名 + 学校メール + Gmail
// are required (both emails must be a valid mail address); 所属チームも名簿のチームが
// あれば必須 (「まだ決まっていない」も可)。the rest is optional.
import { useState } from "react";
import { Button, Card, Form, FormField, Select, Skeleton } from "@dub/ui";
import { usePublicOnboardingItems, useSubmitParticipation } from "./hooks.ts";
import type { PublicParticipationResponse } from "./contracts.ts";
import {
  PersonProfileFields,
  emptyProfileDraft,
  joinParts,
  parseProfileDraft,
  type PersonProfileErrors,
  type PersonProfileKey,
} from "../../lib/personProfile.tsx";
import styles from "./participation.module.css";

// 参加届で必須の項目 (残りは任意)。項目そのものは運営名簿と共通 (PersonProfile)。
const REQUIRED: readonly PersonProfileKey[] = ["lastName", "firstName", "schoolEmail", "gmail"];
// 所属チームの「まだ決まっていない」(送信時は desiredTeamId = null)。
const NO_TEAM = "__none__";
const TEAM_FIELD_ID = "participation-team";

export function ParticipationForm(): JSX.Element {
  const submit = useSubmitParticipation();
  // チームの選択肢は名簿のチーム (公開してよい部分だけを返す公開案内 API)。
  const guide = usePublicOnboardingItems();
  const teams = guide.data?.teams ?? [];
  const [draft, setDraft] = useState(emptyProfileDraft);
  const [errors, setErrors] = useState<PersonProfileErrors>({});
  const [team, setTeam] = useState("");
  const [teamError, setTeamError] = useState<string | null>(null);
  const [done, setDone] = useState<PublicParticipationResponse | null>(null);

  const onSubmit = () => {
    const { profile, errors: next } = parseProfileDraft(draft, REQUIRED);
    setErrors(next);
    const nextTeamError = teams.length > 0 && team === "" ? "所属チームを選択してください" : null;
    setTeamError(nextTeamError);
    if (Object.keys(next).length > 0 || nextTeamError) return;
    submit.mutate(
      {
        ...profile,
        desiredTeamId: team === "" || team === NO_TEAM ? null : team,
        schoolEmail: profile.schoolEmail ?? "",
        gmail: profile.gmail ?? "",
        // 後方互換: 合成した "姓 名" 等も同送する (旧受け口・デモ transport が参照)。
        name: joinParts([profile.lastName, profile.firstName]),
        nameKana: joinParts([profile.lastNameKana, profile.firstNameKana]) || null,
        nameRomaji: joinParts([profile.lastNameRomaji, profile.firstNameRomaji]) || null,
      },
      { onSuccess: (res) => setDone(res) },
    );
  };

  if (done) return <ThanksView result={done} onAgain={() => setDone(null)} />;

  // 読み込み中はスケルトン、取得失敗・チーム 0 件なら欄ごと出さない (提出は妨げない)。
  const teamField = guide.isLoading ? (
    <FormField label="所属チーム" htmlFor={TEAM_FIELD_ID}>
      <Skeleton height={36} testId="participation-team-loading" />
    </FormField>
  ) : teams.length > 0 ? (
    <FormField
      label="所属チーム"
      htmlFor={TEAM_FIELD_ID}
      required
      help="所属する（したい）チーム"
      {...(teamError ? { error: teamError } : {})}
    >
      <Select
        id={TEAM_FIELD_ID}
        value={team.length > 0 ? team : null}
        onChange={(v) => {
          setTeam(v);
          setTeamError(null);
        }}
        options={[...teams.map((t) => ({ value: t.id, label: t.name })), { value: NO_TEAM, label: "まだ決まっていない" }]}
        placeholder="選択してください"
        invalid={teamError !== null}
        testId={TEAM_FIELD_ID}
      />
    </FormField>
  ) : null;

  return (
    <Card>
      <Form onSubmit={onSubmit}>
        <div className={styles.formStack}>
          <PersonProfileFields
            draft={draft}
            onChange={setDraft}
            errors={errors}
            required={REQUIRED}
            idPrefix="participation"
            after={{ desiredActivity: teamField }}
          />
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

function ThanksView({ onAgain }: { result: PublicParticipationResponse; onAgain: () => void }): JSX.Element {
  // 名簿への反映は運営が確認のうえ行うため、受付だけを伝える中立的な文面にする。
  return (
    <div data-testid="participation-thanks">
      <Card>
        <div className={styles.thanksBody}>
          <p className={styles.thanksLead} aria-hidden>
            ✅
          </p>
          <p>参加届を受け付けました。ご提出ありがとうございます。運営が内容を確認します。</p>
          <Button variant="secondary" onClick={onAgain} testId="participation-again">
            続けて提出する
          </Button>
        </div>
      </Card>
    </div>
  );
}
