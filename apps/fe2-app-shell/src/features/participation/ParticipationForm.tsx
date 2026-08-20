// 参加届 form body (shared by the in-shell page and the public standalone page).
// 入力 → バリデーション → 送信 → サンクス。The submit goes to the PUBLIC endpoint, so the
// サンクス view is intentionally generic (no roster/member echo). 氏名 + 学校メール + Gmail
// are required (both emails must be a valid mail address); the rest is optional.
import { useState } from "react";
import { Button, Card, Form, FormField, TextField, Textarea, Select } from "@dub/ui";
import type { SelectOption } from "@dub/ui";
import { useSubmitParticipation } from "./hooks.ts";
import {
  GRADE_LABEL,
  GRADES,
  type Grade,
  type PublicParticipationResponse,
} from "./contracts.ts";
import { kanaToRomaji } from "./romaji.ts";
import styles from "./participation.module.css";

const GRADE_OPTIONS: SelectOption<Grade>[] = GRADES.map((g) => ({ value: g, label: GRADE_LABEL[g] }));

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^[0-9+\-()\s]{6,20}$/;
// 氏名ローマ字: 先頭は英字、以降は英字/空白/ハイフン/アポストロフィ (O'Brien 等)。任意。
const ROMAJI_RE = /^[A-Za-z][A-Za-z\s'-]*$/;
const trimOrNull = (v: string): string | null => (v.trim().length > 0 ? v.trim() : null);
const compose = (last: string, first: string): string => [last.trim(), first.trim()].filter((x) => x.length > 0).join(" ");

type FormErrors = {
  lastName?: string;
  firstName?: string;
  schoolEmail?: string;
  gmail?: string;
  phone?: string;
  lastNameRomaji?: string;
  firstNameRomaji?: string;
};

export function ParticipationForm(): JSX.Element {
  const submit = useSubmitParticipation();

  // 氏名・振り仮名は 姓(last)/名(first) に分割入力する。
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastNameKana, setLastNameKana] = useState("");
  const [firstNameKana, setFirstNameKana] = useState("");
  // 氏名ローマ字 (アルファベットのメール発行に使う). ふりがなから簡易ヘボン式で自動
  // プリフィルするが、本人が直接編集したら以降は上書きしない (edited フラグで判定)。
  const [lastNameRomaji, setLastNameRomaji] = useState("");
  const [firstNameRomaji, setFirstNameRomaji] = useState("");
  const [lastRomajiEdited, setLastRomajiEdited] = useState(false);
  const [firstRomajiEdited, setFirstRomajiEdited] = useState(false);
  const [schoolEmail, setSchoolEmail] = useState("");
  const [gmail, setGmail] = useState("");
  const [phone, setPhone] = useState("");
  const [grade, setGrade] = useState<Grade | null>(null);
  const [department, setDepartment] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [done, setDone] = useState<PublicParticipationResponse | null>(null);

  // ふりがな入力に追従してローマ字を素案プリフィル (本人未編集の間だけ)。
  const onLastKanaChange = (v: string) => {
    setLastNameKana(v);
    if (!lastRomajiEdited) setLastNameRomaji(kanaToRomaji(v));
  };
  const onFirstKanaChange = (v: string) => {
    setFirstNameKana(v);
    if (!firstRomajiEdited) setFirstNameRomaji(kanaToRomaji(v));
  };
  const onLastRomajiChange = (v: string) => {
    setLastRomajiEdited(true);
    setLastNameRomaji(v);
  };
  const onFirstRomajiChange = (v: string) => {
    setFirstRomajiEdited(true);
    setFirstNameRomaji(v);
  };

  const onSubmit = () => {
    const next: FormErrors = {};
    if (lastName.trim().length === 0) next.lastName = "苗字を入力してください";
    if (firstName.trim().length === 0) next.firstName = "名前を入力してください";
    if (schoolEmail.trim().length === 0) next.schoolEmail = "学校のメールアドレスを入力してください";
    else if (!EMAIL_RE.test(schoolEmail.trim())) next.schoolEmail = "メールアドレスの形式が正しくありません";
    if (gmail.trim().length === 0) next.gmail = "Gmail アドレスを入力してください";
    else if (!EMAIL_RE.test(gmail.trim())) next.gmail = "メールアドレスの形式が正しくありません";
    if (phone.trim().length > 0 && !PHONE_RE.test(phone.trim())) next.phone = "電話番号の形式が正しくありません";
    if (lastNameRomaji.trim().length > 0 && !ROMAJI_RE.test(lastNameRomaji.trim()))
      next.lastNameRomaji = "英字（ローマ字）で入力してください";
    if (firstNameRomaji.trim().length > 0 && !ROMAJI_RE.test(firstNameRomaji.trim()))
      next.firstNameRomaji = "英字（ローマ字）で入力してください";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    submit.mutate(
      {
        lastName: lastName.trim(),
        firstName: firstName.trim(),
        // 後方互換: 合成した "姓 名" も同送する (旧受け口・デモtrans が name を参照)。
        name: compose(lastName, firstName),
        schoolEmail: schoolEmail.trim(),
        gmail: gmail.trim(),
        lastNameKana: trimOrNull(lastNameKana),
        firstNameKana: trimOrNull(firstNameKana),
        nameKana: trimOrNull(compose(lastNameKana, firstNameKana)),
        lastNameRomaji: trimOrNull(lastNameRomaji),
        firstNameRomaji: trimOrNull(firstNameRomaji),
        nameRomaji: trimOrNull(compose(lastNameRomaji, firstNameRomaji)),
        phone: trimOrNull(phone),
        grade,
        department: trimOrNull(department),
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
          <div className={styles.formRow}>
            <FormField label="氏名（苗字）" htmlFor="p-last-name" required {...(errors.lastName ? { error: errors.lastName } : {})}>
              <TextField id="p-last-name" value={lastName} onChange={setLastName} testId="participation-last-name" placeholder="山田" />
            </FormField>
            <FormField label="氏名（名前）" htmlFor="p-first-name" required {...(errors.firstName ? { error: errors.firstName } : {})}>
              <TextField id="p-first-name" value={firstName} onChange={setFirstName} testId="participation-first-name" placeholder="太郎" />
            </FormField>
          </div>
          <div className={styles.formRow}>
            <FormField label="ふりがな（せい）" htmlFor="p-last-kana" help="全角かな / カナ">
              <TextField id="p-last-kana" value={lastNameKana} onChange={onLastKanaChange} testId="participation-last-name-kana" placeholder="やまだ" />
            </FormField>
            <FormField label="ふりがな（めい）" htmlFor="p-first-kana" help="全角かな / カナ">
              <TextField id="p-first-kana" value={firstNameKana} onChange={onFirstKanaChange} testId="participation-first-name-kana" placeholder="たろう" />
            </FormField>
          </div>
          <div className={styles.formRow}>
            <FormField
              label="ローマ字（姓）"
              htmlFor="p-last-romaji"
              help="メールアドレス発行に使います（ふりがなから自動入力・修正できます）"
              {...(errors.lastNameRomaji ? { error: errors.lastNameRomaji } : {})}
            >
              <TextField id="p-last-romaji" value={lastNameRomaji} onChange={onLastRomajiChange} testId="participation-last-name-romaji" placeholder="Yamada" />
            </FormField>
            <FormField
              label="ローマ字（名）"
              htmlFor="p-first-romaji"
              help="半角アルファベット"
              {...(errors.firstNameRomaji ? { error: errors.firstNameRomaji } : {})}
            >
              <TextField id="p-first-romaji" value={firstNameRomaji} onChange={onFirstRomajiChange} testId="participation-first-name-romaji" placeholder="Taro" />
            </FormField>
          </div>
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
          <FormField
            label="電話番号"
            htmlFor="p-phone"
            help="緊急連絡用 (任意)"
            {...(errors.phone ? { error: errors.phone } : {})}
          >
            <TextField id="p-phone" type="text" value={phone} onChange={setPhone} testId="participation-phone" placeholder="090-1234-5678" />
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
