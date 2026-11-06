// 面談申し込みフォームの編集 (Google フォーム風)。タイトル・説明・受付の開閉と、質問の追加・削除・並べ替え
// (ドラッグ / キーボード)・形式・必須・選択肢・「応募者のどの項目に入れるか」を下書きで編集して保存する。
// 検証は @dub/types hrForm.validateFormDefinition (サービスと同じ関数)。姓・名とメールの質問は消せず必須固定。
// 保存は楽観的 (useSaveInterviewForm)。閲覧のみの権限では全コントロールが disabled。
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  FormField,
  Icon,
  IconButton,
  Select,
  SortableList,
  Switch,
  TextField,
  Textarea,
} from "@dub/ui";
import { hrForm, member } from "@dub/types";
import { useSaveInterviewForm } from "./interviewFormApi.tsx";
import styles from "./interview-form.module.css";

type Draft = Pick<hrForm.InterviewForm, "title" | "description" | "questions" | "accepting">;

const TYPE_OPTIONS = hrForm.FORM_QUESTION_TYPES.map((t) => ({ value: t, label: hrForm.FORM_QUESTION_TYPE_LABELS[t] }));
const NO_BINDING = "__none__";

function toDraft(f: hrForm.InterviewForm): Draft {
  return { title: f.title, description: f.description, questions: f.questions, accepting: f.accepting };
}

const isLocked = (q: hrForm.FormQuestion) => q.binding !== null && hrForm.REQUIRED_BINDINGS.includes(q.binding);

function errorText(field: string, reason: string): string {
  if (field === "title") return "フォームのタイトルを入力してください";
  if (reason === "missing_lastName" || reason === "missing_firstName") return "苗字と名前を入れる質問が必要です";
  if (reason === "missing_email") return "メールアドレスを入れる質問が必要です";
  if (reason === "grade_options") return `学年は参加届と同じ選択肢（${member.GRADES.map((g) => member.GRADE_LABEL[g]).join("・")}）から作ってください`;
  if (field.endsWith(".label")) return "質問文を入力してください";
  if (field.endsWith(".options")) return "選択肢を 1 つ以上、重複なしで入力してください";
  if (field.endsWith(".binding")) return "この形式では選べない項目か、別の質問ですでに使っています";
  return "入力内容を確認してください";
}

export function InterviewFormEditor({ form, canWrite }: { form: hrForm.InterviewForm; canWrite: boolean }): JSX.Element {
  const save = useSaveInterviewForm();
  const [draft, setDraft] = useState<Draft>(() => toDraft(form));
  const [baseVersion, setBaseVersion] = useState(form.version);
  const [showErrors, setShowErrors] = useState(false);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(form)), [draft, form]);
  // 他の人の保存や自分の保存確定でサーバの版が進んだら、未編集のときだけ取り込む。
  useEffect(() => {
    if (form.version !== baseVersion && !dirty) {
      setDraft(toDraft(form));
      setBaseVersion(form.version);
    }
  }, [form, baseVersion, dirty]);

  const errors = useMemo(() => hrForm.validateFormDefinition(draft), [draft]);
  const errorAt = (field: string) => (showErrors ? errors.find((e) => e.field === field) : undefined);
  const qError = (i: number, prop: string) => {
    const e = errorAt(`questions.${i}.${prop}`);
    return e ? errorText(e.field, e.reason) : undefined;
  };
  const formLevel = showErrors ? errors.filter((e) => e.field === "questions") : [];

  const setQ = (id: string, patch: Partial<hrForm.FormQuestion>) =>
    setDraft((d) => ({ ...d, questions: d.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)) }));

  const changeType = (q: hrForm.FormQuestion, type: hrForm.FormQuestionType) => {
    const choice = hrForm.CHOICE_TYPES.includes(type);
    setQ(q.id, {
      type,
      options: choice ? (q.options.length > 0 ? q.options : ["選択肢 1"]) : [],
      // 形式に合わない binding は外す。
      binding: q.binding && hrForm.BINDING_TYPES[q.binding].includes(type) ? q.binding : null,
    });
  };

  const addQuestion = () =>
    setDraft((d) => ({
      ...d,
      questions: [
        ...d.questions,
        { id: hrForm.newQuestionId(), type: "short_text", label: "", description: null, required: false, options: [], binding: null },
      ],
    }));

  const onSave = () => {
    setShowErrors(true);
    if (errors.length > 0) return;
    const body: hrForm.SaveInterviewFormRequest = { ...draft, expectedVersion: form.version };
    save.mutate(body, {
      onSuccess: (saved) => {
        setDraft(toDraft(saved));
        setBaseVersion(saved.version);
        setShowErrors(false);
      },
    });
  };

  const titleError = errorAt("title");
  const disabled = !canWrite;

  return (
    <Card header="フォームの編集" testId="fe2-hr-form-editor">
      <div className={styles.editorHead}>
        <p className={styles.hint}>
          質問は自由に追加・並べ替えできます。「応募者の項目」を選んだ質問の回答は応募者の表（氏名・メール・学科など）に入り、それ以外の回答は応募者の詳細に表示されます。
        </p>
        <FormField label="フォームのタイトル" htmlFor="hr-form-title" required {...(titleError ? { error: errorText("title", titleError.reason) } : {})}>
          <TextField
            id="hr-form-title"
            testId="fe2-hr-form-title"
            value={draft.title}
            onChange={(title) => setDraft((d) => ({ ...d, title }))}
            invalid={!!titleError}
            disabled={disabled}
          />
        </FormField>
        <FormField label="説明（フォームの最初に表示）" htmlFor="hr-form-description">
          <Textarea
            id="hr-form-description"
            testId="fe2-hr-form-description"
            rows={3}
            value={draft.description ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, description: v }))}
            disabled={disabled}
          />
        </FormField>
        <Switch
          id="hr-form-accepting"
          testId="fe2-hr-form-accepting"
          checked={draft.accepting}
          onChange={(accepting) => setDraft((d) => ({ ...d, accepting }))}
          label={draft.accepting ? "回答を受け付けています" : "回答の受付を停止しています（公開ページは「受付終了」と表示）"}
          disabled={disabled}
        />
      </div>

      <div className={styles.spaced}>
        <SortableList<hrForm.FormQuestion>
          items={draft.questions}
          getItemId={(q) => q.id}
          disabled={disabled}
          aria-label="質問（ドラッグで並び替え）"
          testId="fe2-hr-form-questions"
          className={styles.editorList}
          onReorder={({ oldIndex, newIndex }) =>
            setDraft((d) => {
              const qs = [...d.questions];
              const [moved] = qs.splice(oldIndex, 1);
              if (moved) qs.splice(newIndex, 0, moved);
              return { ...d, questions: qs };
            })
          }
          renderItem={(q, ctx) => {
            const i = draft.questions.indexOf(q);
            const locked = isLocked(q);
            const usedBindings = new Set(draft.questions.filter((x) => x.id !== q.id && x.binding).map((x) => x.binding));
            const bindingOptions = [
              { value: NO_BINDING, label: "入れない（回答としてだけ残す）" },
              ...hrForm.APPLICANT_BINDINGS.filter((b) => hrForm.BINDING_TYPES[b].includes(q.type)).map((b) => ({
                value: b,
                label: hrForm.APPLICANT_BINDING_LABELS[b],
                disabled: usedBindings.has(b),
              })),
            ];
            return (
              <div className={styles.questionCard} data-dragging={ctx.isDragging || undefined} data-testid={`fe2-hr-form-q-${q.id}`}>
                {canWrite ? (
                  <span className={styles.dragHandle} aria-label="ドラッグして並び替え" {...ctx.dragHandleProps}>
                    <Icon name="drag" />
                  </span>
                ) : null}
                <div className={styles.questionBody}>
                  <div className={styles.questionRow}>
                    <FormField label={`質問 ${i + 1}`} htmlFor={`hr-form-q-${q.id}-label`} required {...(qError(i, "label") ? { error: qError(i, "label")! } : {})}>
                      <TextField
                        id={`hr-form-q-${q.id}-label`}
                        testId={`fe2-hr-form-q-${q.id}-label`}
                        value={q.label}
                        onChange={(label) => setQ(q.id, { label })}
                        placeholder="質問文"
                        invalid={!!qError(i, "label")}
                        disabled={disabled}
                      />
                    </FormField>
                    <FormField label="形式" htmlFor={`hr-form-q-${q.id}-type`}>
                      <Select<hrForm.FormQuestionType>
                        id={`hr-form-q-${q.id}-type`}
                        testId={`fe2-hr-form-q-${q.id}-type`}
                        value={q.type}
                        options={TYPE_OPTIONS}
                        onChange={(t) => changeType(q, t)}
                        disabled={disabled || locked}
                      />
                    </FormField>
                  </div>
                  <FormField label="補足説明（任意）" htmlFor={`hr-form-q-${q.id}-desc`}>
                    <TextField
                      id={`hr-form-q-${q.id}-desc`}
                      value={q.description ?? ""}
                      onChange={(v) => setQ(q.id, { description: v })}
                      disabled={disabled}
                    />
                  </FormField>
                  {hrForm.CHOICE_TYPES.includes(q.type) ? (
                    <OptionsEditor q={q} disabled={disabled} error={qError(i, "options")} onChange={(options) => setQ(q.id, { options })} />
                  ) : null}
                  <div className={styles.questionFooter}>
                    <div className={styles.bindingField}>
                      <FormField label="応募者の項目に入れる" htmlFor={`hr-form-q-${q.id}-binding`} {...(qError(i, "binding") ? { error: qError(i, "binding")! } : {})}>
                        <Select
                          id={`hr-form-q-${q.id}-binding`}
                          testId={`fe2-hr-form-q-${q.id}-binding`}
                          value={q.binding ?? NO_BINDING}
                          options={bindingOptions}
                          onChange={(v) => {
                            const binding = v === NO_BINDING ? null : (v as hrForm.ApplicantBinding);
                            setQ(q.id, {
                              binding,
                              ...(binding && hrForm.REQUIRED_BINDINGS.includes(binding) ? { required: true } : {}),
                            });
                          }}
                          disabled={disabled || locked}
                        />
                      </FormField>
                    </div>
                    <Switch
                      id={`hr-form-q-${q.id}-required`}
                      testId={`fe2-hr-form-q-${q.id}-required`}
                      checked={q.required}
                      onChange={(required) => setQ(q.id, { required })}
                      label="必須"
                      disabled={disabled || locked}
                    />
                    {locked ? (
                      <span className={styles.lockedNote}>氏名・メールの質問は消せません</span>
                    ) : (
                      <IconButton
                        name="trash"
                        aria-label={`「${q.label || `質問 ${i + 1}`}」を削除`}
                        testId={`fe2-hr-form-q-${q.id}-delete`}
                        disabled={disabled}
                        onClick={() => setDraft((d) => ({ ...d, questions: d.questions.filter((x) => x.id !== q.id) }))}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          }}
        />
      </div>

      <div className={`${styles.editorActions} ${styles.spaced}`}>
        <Button
          variant="secondary"
          iconLeft={<Icon name="plus" />}
          testId="fe2-hr-form-add-question"
          disabled={disabled || draft.questions.length >= hrForm.FORM_LIMITS.questions}
          onClick={addQuestion}
        >
          質問を追加
        </Button>
        <div className={styles.shareActions}>
          {dirty ? <span className={styles.dirtyNote} data-testid="fe2-hr-form-dirty">保存していない変更があります</span> : null}
          <Button variant="ghost" testId="fe2-hr-form-reset" disabled={disabled || !dirty} onClick={() => setDraft(toDraft(form))}>
            変更を破棄
          </Button>
          <Button testId="fe2-hr-form-save" disabled={disabled || !dirty} loading={save.isPending} onClick={onSave}>
            保存する
          </Button>
        </div>
      </div>
      {showErrors && errors.length > 0 ? (
        <p className={styles.errorSummary} role="alert" data-testid="fe2-hr-form-errors">
          {formLevel.length > 0 ? formLevel.map((e) => errorText(e.field, e.reason)).join(" / ") : "入力内容を確認してください（赤い欄）"}
        </p>
      ) : null}
    </Card>
  );
}

function OptionsEditor({
  q,
  disabled,
  error,
  onChange,
}: {
  q: hrForm.FormQuestion;
  disabled: boolean;
  error: string | undefined;
  onChange: (options: string[]) => void;
}): JSX.Element {
  return (
    <FormField label="選択肢" htmlFor={`hr-form-q-${q.id}-opt-0`} {...(error ? { error } : {})}>
      <div className={styles.optionList} data-testid={`fe2-hr-form-q-${q.id}-options`}>
        {q.options.map((o, i) => (
          <div className={styles.optionRow} key={i}>
            <TextField
              id={`hr-form-q-${q.id}-opt-${i}`}
              testId={`fe2-hr-form-q-${q.id}-opt-${i}`}
              value={o}
              onChange={(v) => onChange(q.options.map((x, j) => (j === i ? v : x)))}
              disabled={disabled}
            />
            <IconButton
              name="x"
              aria-label={`選択肢「${o}」を削除`}
              disabled={disabled || q.options.length <= 1}
              onClick={() => onChange(q.options.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<Icon name="plus" />}
            testId={`fe2-hr-form-q-${q.id}-add-option`}
            disabled={disabled || q.options.length >= hrForm.FORM_LIMITS.options}
            onClick={() => onChange([...q.options, `選択肢 ${q.options.length + 1}`])}
          >
            選択肢を追加
          </Button>
        </div>
      </div>
    </FormField>
  );
}
