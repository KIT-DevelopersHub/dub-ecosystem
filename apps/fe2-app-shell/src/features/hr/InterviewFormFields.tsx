// 面談申し込みフォームの「回答する側」の入力欄。公開ページと人事の代理入力 (モーダル) で共有する。
// 検証は @dub/types hrForm.validateAnswers (サービスと同じ関数) で、項目ごとのエラー文言に直して出す。
import { useCallback, useState } from "react";
import { Checkbox, DatePicker, FormField, Radio, Select, TextField, Textarea } from "@dub/ui";
import { hrForm } from "@dub/types";
import styles from "./interview-form.module.css";

const REASON_TEXT: Record<string, string> = {
  required: "入力してください",
  invalid: "形式が正しくありません",
  too_long: "長すぎます",
};

function messageOf(q: hrForm.FormQuestion, reason: string): string {
  if (reason === "required") return CHOICE_REQUIRED.includes(q.type) ? "選択してください" : "入力してください";
  if (reason === "invalid" && q.type === "email") return "メールアドレスの形式で入力してください";
  if (reason === "invalid" && q.type === "phone") return "電話番号を数字とハイフンで入力してください";
  return REASON_TEXT[reason] ?? "入力内容を確認してください";
}
const CHOICE_REQUIRED: readonly hrForm.FormQuestionType[] = ["single_choice", "multiple_choice", "dropdown", "date"];

export type AnswerErrors = Record<string, string>;

/** "answers.<id>" 形式のフィールドエラー (クライアント検証 / サーバ 400) を質問 id → 文言に直す。 */
export function toAnswerErrors(
  questions: readonly hrForm.FormQuestion[],
  fieldErrors: readonly { field: string; reason: string }[],
): AnswerErrors {
  const out: AnswerErrors = {};
  for (const e of fieldErrors) {
    const id = e.field.startsWith("answers.") ? e.field.slice("answers.".length) : null;
    const q = id ? questions.find((x) => x.id === id) : undefined;
    if (q && !out[q.id]) out[q.id] = messageOf(q, e.reason);
  }
  return out;
}

/** 回答の下書き + 送信前の検証。 */
export function useAnswerDraft(questions: readonly hrForm.FormQuestion[]) {
  const [answers, setAnswers] = useState<hrForm.FormAnswers>({});
  const [errors, setErrors] = useState<AnswerErrors>({});
  const setAnswer = useCallback((id: string, v: hrForm.FormAnswerValue) => {
    setAnswers((a) => ({ ...a, [id]: v }));
    setErrors((e) => {
      if (!(id in e)) return e;
      const next = { ...e };
      delete next[id];
      return next;
    });
  }, []);
  /** 通れば正規化済みの回答、だめならエラーを表示して null。 */
  const validate = useCallback((): hrForm.FormAnswers | null => {
    const { value, errors: bad } = hrForm.validateAnswers(questions, answers);
    const next = toAnswerErrors(questions, bad);
    setErrors(next);
    return Object.keys(next).length > 0 ? null : value;
  }, [questions, answers]);
  const reset = useCallback(() => {
    setAnswers({});
    setErrors({});
  }, []);
  return { answers, errors, setAnswer, setErrors, validate, reset };
}

export function InterviewFormFields({
  questions,
  answers,
  errors,
  onChange,
  idPrefix,
}: {
  questions: readonly hrForm.FormQuestion[];
  answers: hrForm.FormAnswers;
  errors: AnswerErrors;
  onChange: (id: string, value: hrForm.FormAnswerValue) => void;
  /** 同じ画面に 2 つ出しても id が衝突しないように。 */
  idPrefix: string;
}): JSX.Element {
  return (
    <div className={styles.answerList} data-testid={`${idPrefix}-fields`}>
      {questions.map((q) => (
        <QuestionInput key={q.id} q={q} value={answers[q.id]} error={errors[q.id]} onChange={(v) => onChange(q.id, v)} idPrefix={idPrefix} />
      ))}
    </div>
  );
}

function QuestionInput({
  q,
  value,
  error,
  onChange,
  idPrefix,
}: {
  q: hrForm.FormQuestion;
  value: hrForm.FormAnswerValue | undefined;
  error: string | undefined;
  onChange: (v: hrForm.FormAnswerValue) => void;
  idPrefix: string;
}): JSX.Element {
  const id = `${idPrefix}-${q.id}`;
  const testId = `${idPrefix}-q-${q.id}`;
  const text = typeof value === "string" ? value : "";
  const list = Array.isArray(value) ? value : [];
  let input: JSX.Element;
  switch (q.type) {
    case "long_text":
      input = <Textarea id={id} testId={testId} rows={4} value={text} onChange={onChange} invalid={!!error} />;
      break;
    case "email":
      input = <TextField id={id} testId={testId} type="email" value={text} onChange={onChange} invalid={!!error} placeholder="name@example.com" />;
      break;
    case "phone":
      input = <TextField id={id} testId={testId} value={text} onChange={onChange} invalid={!!error} placeholder="090-1234-5678" />;
      break;
    case "date":
      input = <DatePicker id={id} testId={testId} value={text || null} onChange={(v) => onChange(v ?? "")} invalid={!!error} />;
      break;
    case "dropdown":
      input = (
        <Select
          id={id}
          testId={testId}
          value={text || null}
          onChange={onChange}
          placeholder="選択してください"
          invalid={!!error}
          options={q.options.map((o) => ({ value: o, label: o }))}
        />
      );
      break;
    case "single_choice":
      input = (
        <div className={styles.choiceGroup} role="radiogroup" id={id} data-testid={testId}>
          {q.options.map((o, i) => (
            <Radio key={o} id={`${id}-${i}`} name={id} value={o} checked={text === o} onChange={onChange} label={o} testId={`${testId}-${i}`} />
          ))}
        </div>
      );
      break;
    case "multiple_choice":
      input = (
        <div className={styles.choiceGroup} role="group" id={id} data-testid={testId}>
          {q.options.map((o, i) => (
            <Checkbox
              key={o}
              id={`${id}-${i}`}
              checked={list.includes(o)}
              onChange={(on) => onChange(on ? [...list, o] : list.filter((x) => x !== o))}
              label={o}
              testId={`${testId}-${i}`}
            />
          ))}
        </div>
      );
      break;
    default:
      input = <TextField id={id} testId={testId} value={text} onChange={onChange} invalid={!!error} />;
  }
  return (
    <FormField label={q.label} htmlFor={id} required={q.required} {...(q.description ? { help: q.description } : {})} {...(error ? { error } : {})}>
      {input}
    </FormField>
  );
}
