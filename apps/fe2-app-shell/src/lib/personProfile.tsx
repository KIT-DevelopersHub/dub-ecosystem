// 人物プロフィール (運営名簿と参加届の共通項目) の入力部品と表示ヘルパー。
//
// 項目の集合・項目名・検証ルールは @dub/types の member.PersonProfile が正典。ここは
// その画面向けの見た目 (並び・2 列配置・プレースホルダ・入力種別) だけを持つ。
// 参加届フォーム・アカウント設定 (参加情報)・メンバー追加/編集の 3 画面がこの部品を
// 共有するので、項目を足すときは型と下の PERSON_PROFILE_FIELDS を直せば全画面に出る。
import { FormField, Select, TextField, Textarea } from "@dub/ui";
import { member } from "@dub/types";
import { kanaToRomaji } from "./romaji.ts";
import styles from "./personProfile.module.css";

export type PersonProfile = member.PersonProfile;
export type PersonProfileKey = member.PersonProfileKey;
/** 入力中の値 (未入力は "")。 */
export type PersonProfileDraft = Record<PersonProfileKey, string>;
export type PersonProfileErrors = Partial<Record<PersonProfileKey, string>>;

export interface PersonProfileFieldDescriptor {
  key: PersonProfileKey;
  label: string;
  kind: "text" | "email" | "textarea" | "select";
  /** 次の half 項目と 2 列で並べる。 */
  half?: boolean;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

type FieldUi = Omit<PersonProfileFieldDescriptor, "key" | "label">;

// 型の Record なので、PersonProfile に項目が増えるとここが埋まるまでコンパイルが通らない。
const FIELD_UI: Record<PersonProfileKey, FieldUi> = {
  lastName: { kind: "text", half: true, placeholder: "山田" },
  firstName: { kind: "text", half: true, placeholder: "太郎" },
  lastNameKana: { kind: "text", half: true, help: "全角かな / カナ", placeholder: "やまだ" },
  firstNameKana: { kind: "text", half: true, help: "全角かな / カナ", placeholder: "たろう" },
  lastNameRomaji: { kind: "text", half: true, help: "メールアドレス発行に使います（ふりがなから自動入力）", placeholder: "Yamada" },
  firstNameRomaji: { kind: "text", half: true, help: "半角アルファベット", placeholder: "Taro" },
  schoolEmail: { kind: "email", half: true, help: "学校から配布されたアドレス", placeholder: "you@school.ac.jp" },
  gmail: { kind: "email", half: true, help: "連絡・共有に使う Gmail", placeholder: "you@gmail.com" },
  phone: { kind: "text", half: true, help: "緊急連絡用", placeholder: "090-1234-5678" },
  rosterNumber: { kind: "text", half: true, help: "例: 3EP2-26", placeholder: "3EP2-26" },
  grade: {
    kind: "select",
    half: true,
    options: member.GRADES.map((g) => ({ value: g, label: member.GRADE_LABEL[g] })),
  },
  department: { kind: "text", half: true, placeholder: "情報工学科" },
  desiredActivity: {
    kind: "select",
    options: member.DESIRED_ACTIVITIES.map((a) => ({ value: a, label: member.ACTIVITY_LABEL[a] })),
  },
  note: { kind: "textarea", help: "連絡事項など" },
};

/** 画面の表示順 (2 列の組み合わせを考えた並び)。全キーを 1 回ずつ含むことをテストで保証。 */
const FIELD_ORDER: readonly PersonProfileKey[] = [
  "lastName",
  "firstName",
  "lastNameKana",
  "firstNameKana",
  "lastNameRomaji",
  "firstNameRomaji",
  "schoolEmail",
  "gmail",
  "phone",
  "rosterNumber",
  "grade",
  "department",
  "desiredActivity",
  "note",
];

export const PERSON_PROFILE_FIELDS: PersonProfileFieldDescriptor[] = FIELD_ORDER.map((key) => ({
  key,
  label: member.PERSON_PROFILE_LABEL[key],
  ...FIELD_UI[key],
}));

export function emptyProfileDraft(): PersonProfileDraft {
  return Object.fromEntries(member.PERSON_PROFILE_KEYS.map((k) => [k, ""])) as PersonProfileDraft;
}

export function toProfileDraft(p: Partial<PersonProfile> | null | undefined): PersonProfileDraft {
  const d = emptyProfileDraft();
  if (!p) return d;
  for (const k of member.PERSON_PROFILE_KEYS) d[k] = p[k] ?? "";
  return d;
}

/** 入力値を検証して PersonProfile にする (サーバと同じ member.parsePersonProfileField)。
 *  `required` に挙げた項目は空ならエラー。 */
export function parseProfileDraft(
  draft: PersonProfileDraft,
  required: readonly PersonProfileKey[] = [],
): { profile: PersonProfile; errors: PersonProfileErrors } {
  const profile = member.emptyPersonProfile();
  const errors: PersonProfileErrors = {};
  for (const k of member.PERSON_PROFILE_KEYS) {
    const r = member.parsePersonProfileField(k, draft[k]);
    if (!r.ok) {
      errors[k] = member.PERSON_PROFILE_ERROR[k] ?? `${member.PERSON_PROFILE_LABEL[k]}の形式が正しくありません`;
      continue;
    }
    (profile as unknown as Record<string, unknown>)[k] = r.value;
    if (r.value === null && required.includes(k)) errors[k] = `${member.PERSON_PROFILE_LABEL[k]}を入力してください`;
  }
  return { profile, errors };
}

/** 一覧・詳細・ダウンロード用の表示文字列 (未入力は "")。 */
export const formatProfileValue = member.formatPersonProfileValue;

/** 苗字・名前を 1 つにした表示 ("山田 太郎")。 */
export function joinParts(parts: (string | null | undefined)[]): string {
  return parts.filter((x): x is string => !!x && x.trim().length > 0).join(" ");
}

export interface ProfileDisplayColumn {
  /** 列キー (表示列ピッカーの保存キーにもなる)。 */
  id: string;
  header: string;
  /** この列が表している PersonProfile の項目 (網羅テスト用)。 */
  keys: readonly PersonProfileKey[];
  value: (p: DisplaySource) => string;
}

/** 参加届の旧データは 姓/名 分割が無く合成値 (nameKana / nameRomaji) だけを持つ。 */
export type DisplaySource = Partial<PersonProfile> & { nameKana?: string | null; nameRomaji?: string | null };

const single = (key: PersonProfileKey): ProfileDisplayColumn => ({
  id: key,
  header: member.PERSON_PROFILE_LABEL[key],
  keys: [key],
  value: (p) => formatProfileValue(key, p),
});

/** 一覧・詳細・ダウンロードで使う人物プロフィールの列 (氏名列は各画面が持つ)。運営名簿と
 *  参加届の回答一覧が同じ列を出すための正典で、全項目を網羅することをテストで保証する。 */
export const PROFILE_DISPLAY_COLUMNS: readonly ProfileDisplayColumn[] = [
  {
    id: "nameKana",
    header: "ふりがな",
    keys: ["lastNameKana", "firstNameKana"],
    value: (p) => joinParts([p.lastNameKana, p.firstNameKana]) || (p.nameKana ?? ""),
  },
  single("rosterNumber"),
  {
    id: "nameRomaji",
    header: "氏名（ローマ字）",
    keys: ["lastNameRomaji", "firstNameRomaji"],
    value: (p) => joinParts([p.lastNameRomaji, p.firstNameRomaji]) || (p.nameRomaji ?? ""),
  },
  single("grade"),
  single("department"),
  single("schoolEmail"),
  single("gmail"),
  single("phone"),
  single("desiredActivity"),
  single("note"),
];

/** 姓/名 が無い旧データ用: 表示名を最初の空白で 姓/名 に分ける (空白が無ければ全体を姓)。 */
export function splitDisplayName(name: string): { lastName: string; firstName: string } {
  const t = name.trim();
  const m = /^(\S+)[\s　]+(.+)$/.exec(t);
  return m ? { lastName: m[1]!, firstName: m[2]!.trim() } : { lastName: t, firstName: "" };
}

function toKebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** 人物プロフィールの入力欄一式。ふりがなを入れるとローマ字を自動入力する (本人が
 *  ローマ字を直接編集した後は上書きしない)。id / testId は `${idPrefix}-${kebab(key)}`。 */
export function PersonProfileFields({
  draft,
  onChange,
  errors = {},
  required = [],
  idPrefix,
  idFor,
}: {
  draft: PersonProfileDraft;
  onChange: (next: PersonProfileDraft) => void;
  errors?: PersonProfileErrors;
  required?: readonly PersonProfileKey[];
  idPrefix: string;
  /** id の付け方を変えたい画面用 (既定は `${idPrefix}-${kebab(key)}`)。 */
  idFor?: (key: PersonProfileKey) => string;
}): JSX.Element {
  const id = (k: PersonProfileKey) => (idFor ? idFor(k) : `${idPrefix}-${toKebab(k)}`);

  const set = (k: PersonProfileKey, v: string) => {
    const next = { ...draft, [k]: v };
    // ローマ字が未入力か、ふりがなからの自動値のままなら追従させる。
    const romajiOf: Partial<Record<PersonProfileKey, PersonProfileKey>> = {
      lastNameKana: "lastNameRomaji",
      firstNameKana: "firstNameRomaji",
    };
    const r = romajiOf[k];
    if (r && (draft[r] === "" || draft[r] === kanaToRomaji(draft[k]))) next[r] = kanaToRomaji(v);
    onChange(next);
  };

  const control = (f: PersonProfileFieldDescriptor) => {
    const fid = id(f.key);
    const val = draft[f.key];
    if (f.kind === "select") {
      return (
        <Select
          id={fid}
          value={val.length > 0 ? val : null}
          onChange={(v) => set(f.key, v)}
          options={f.options ?? []}
          placeholder="選択してください"
          testId={fid}
        />
      );
    }
    if (f.kind === "textarea") return <Textarea id={fid} value={val} onChange={(v) => set(f.key, v)} rows={3} testId={fid} />;
    return (
      <TextField
        id={fid}
        type={f.kind === "email" ? "email" : "text"}
        value={val}
        onChange={(v) => set(f.key, v)}
        {...(f.placeholder ? { placeholder: f.placeholder } : {})}
        testId={fid}
      />
    );
  };

  const field = (f: PersonProfileFieldDescriptor) => {
    // 必須だけ * で示す (任意は既定なので書かない)。
    const isRequired = required.includes(f.key);
    const help = f.help;
    const err = errors[f.key];
    return (
      <FormField
        key={f.key}
        label={f.label}
        htmlFor={id(f.key)}
        required={isRequired}
        {...(help ? { help } : {})}
        {...(err ? { error: err } : {})}
      >
        {control(f)}
      </FormField>
    );
  };

  const rows: PersonProfileFieldDescriptor[][] = [];
  let buf: PersonProfileFieldDescriptor[] = [];
  for (const f of PERSON_PROFILE_FIELDS) {
    if (f.half) {
      buf.push(f);
      if (buf.length === 2) {
        rows.push(buf);
        buf = [];
      }
    } else {
      if (buf.length) rows.push(buf);
      buf = [];
      rows.push([f]);
    }
  }
  if (buf.length) rows.push(buf);

  return (
    <div className={styles.stack}>
      {rows.map((row) =>
        row.length > 1 ? (
          <div key={row[0]!.key} className={styles.row}>
            {row.map(field)}
          </div>
        ) : (
          field(row[0]!)
        ),
      )}
    </div>
  );
}
