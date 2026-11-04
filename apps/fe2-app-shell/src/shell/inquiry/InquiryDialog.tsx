// InquiryDialog (shell chrome) — ⚙ 設定 → 問い合わせ. Replaces the old always-visible
// bottom-right feedback button: the member picks a 種別 (フィードバック / 名刺が切れた /
// 友達を誘いたい / 面談を希望する / その他), fills that kind's fields, and it is filed
// through the existing feedback pipeline (POST /api/v1/feedback, `kind` set) so admins
// get the same inbox notification + email, labelled by kind.
//
// Composed from @dub/ui only: Modal (Esc / focus trap / overlay dismiss), Form/FormField,
// Radio, TextField, Textarea, Select, Button.
import { useCallback, useState } from "react";
import { Modal, Form, FormField, Textarea, TextField, Select, Radio, Button, Icon } from "@dub/ui";
import type { SelectOption } from "@dub/ui";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { capturePageContext, submitInquiry } from "./inquiryApi.tsx";
import {
  INQUIRY_KIND_SPECS,
  composeInquiryMessage,
  firstMissingField,
  specOf,
  type FeedbackCategory,
  type InquiryField,
  type InquiryKind,
} from "./inquiryKinds.ts";
import styles from "./InquiryDialog.module.css";

// Values MUST be members of the backend FEEDBACK_CATEGORIES enum (bug|idea|question|other).
const CATEGORY_OPTIONS: SelectOption<FeedbackCategory>[] = [
  { value: "bug", label: "バグ・不具合" },
  { value: "idea", label: "改善要望" },
  { value: "question", label: "使い方の質問" },
  { value: "other", label: "その他" },
];

type SubmitStatus = "idle" | "submitting" | "success" | "error";

const fieldId = (key: string) => `fe2-inquiry-${key}`;

export interface InquiryDialogProps {
  api: ApiClient;
  open: boolean;
  onClose: () => void;
}

export function InquiryDialog({ api, open, onClose }: InquiryDialogProps): JSX.Element {
  const [kind, setKind] = useState<InquiryKind>("feedback");
  const [values, setValues] = useState<Record<string, string>>({});
  const [category, setCategory] = useState<FeedbackCategory>("other");
  const [status, setStatus] = useState<SubmitStatus>("idle");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ key: string; error: string } | null>(null);

  const spec = specOf(kind);

  const close = useCallback(() => {
    onClose();
    setKind("feedback");
    setValues({});
    setCategory("other");
    setStatus("idle");
    setErrorText(null);
    setFieldError(null);
  }, [onClose]);

  const changeKind = (next: string) => {
    setKind(next as InquiryKind);
    setFieldError(null);
    setErrorText(null);
  };

  const setValue = (key: string, v: string) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    if (fieldError?.key === key) setFieldError(null);
  };

  const handleSubmit = useCallback(async () => {
    if (status === "submitting") return;
    const missing = firstMissingField(spec, values);
    if (missing) {
      setFieldError(missing);
      return;
    }
    setFieldError(null);
    setErrorText(null);
    setStatus("submitting");
    try {
      await submitInquiry(api, {
        kind,
        message: composeInquiryMessage(spec, values),
        category: kind === "feedback" ? category : "other",
        ...capturePageContext(),
      });
      setStatus("success");
    } catch (e) {
      setStatus("error");
      setErrorText(ApiError.isApiError(e) ? toDisplayableError(e).message : "送信に失敗しました。時間をおいて再度お試しください。");
    }
  }, [api, category, kind, spec, status, values]);

  const ctx = open ? capturePageContext() : null;

  const renderField = (f: InquiryField) => {
    const id = fieldId(f.key);
    const common = {
      id,
      testId: id,
      value: values[f.key] ?? "",
      onChange: (v: string) => setValue(f.key, v),
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    };
    return (
      <FormField
        key={`${kind}-${f.key}`}
        label={f.label}
        htmlFor={id}
        required={Boolean(f.required)}
        {...(fieldError?.key === f.key ? { error: fieldError.error } : {})}
      >
        {f.input === "textarea" ? (
          <Textarea {...common} rows={f.key === "message" ? 5 : 3} />
        ) : (
          <TextField {...common} type={f.input === "number" ? "number" : "text"} />
        )}
      </FormField>
    );
  };

  return (
    <Modal open={open} onClose={close} title="問い合わせ" size="sm" testId="fe2-inquiry-dialog">
      {status === "success" ? (
        <div className={styles.done} data-testid="fe2-inquiry-success">
          <span className={styles.doneMark} aria-hidden="true">
            <Icon name="check" />
          </span>
          <p className={styles.doneTitle}>送信しました。ありがとうございます！</p>
          <p className={styles.doneSub}>いただいた内容は運営が確認します。</p>
          <div className={styles.actions}>
            <Button testId="fe2-inquiry-close" variant="secondary" onClick={close}>
              閉じる
            </Button>
          </div>
        </div>
      ) : (
        <Form testId="fe2-inquiry-form" onSubmit={handleSubmit}>
          <fieldset className={styles.kinds} data-testid="fe2-inquiry-kinds">
            <legend className={styles.kindsLegend}>種別</legend>
            {INQUIRY_KIND_SPECS.map((s) => (
              <Radio
                key={s.kind}
                id={`fe2-inquiry-kind-${s.kind}`}
                testId={`fe2-inquiry-kind-${s.kind}`}
                name="fe2-inquiry-kind"
                value={s.kind}
                checked={kind === s.kind}
                onChange={changeKind}
                label={s.label}
              />
            ))}
          </fieldset>

          <p className={styles.lead} data-testid="fe2-inquiry-lead">
            {spec.lead}
          </p>

          {kind === "feedback" ? (
            <FormField label="カテゴリ" htmlFor="fe2-inquiry-category">
              <Select<FeedbackCategory>
                id="fe2-inquiry-category"
                testId="fe2-inquiry-category"
                value={category}
                onChange={setCategory}
                options={CATEGORY_OPTIONS}
              />
            </FormField>
          ) : null}
          {spec.fields.map(renderField)}

          {ctx && kind === "feedback" ? (
            <p className={styles.context} data-testid="fe2-inquiry-context">
              <Icon name="info" size="sm" aria-label="送信元ページ" />
              <span>
                送信元: <span className={styles.contextPage}>{ctx.screenName}</span>
                <span className={styles.contextPath}>（{ctx.pagePath}）</span>
              </span>
            </p>
          ) : null}

          {errorText ? (
            <p className={styles.error} role="alert" data-testid="fe2-inquiry-error">
              {errorText}
            </p>
          ) : null}

          <div className={styles.actions}>
            <Button testId="fe2-inquiry-cancel" variant="secondary" type="button" onClick={close} disabled={status === "submitting"}>
              キャンセル
            </Button>
            <Button testId="fe2-inquiry-submit" type="submit" loading={status === "submitting"} iconLeft={<Icon name="send" />}>
              送信
            </Button>
          </div>
        </Form>
      )}
    </Modal>
  );
}
