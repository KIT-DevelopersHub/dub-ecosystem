// FeedbackWidget (shell chrome) — a persistent bottom-right floating button that
// opens a small お問い合わせ/フィードバック form, LMB-style. Mounted once by
// AppShellLayout for authenticated users, so it rides along on every screen.
//
// FE2 does wiring only: the panel reuses @dub/ui Modal (Esc-to-close + focus trap
// + overlay dismiss come for free), Form/FormField/Textarea/Select, and Button.
// Submit POSTs POST /api/v1/feedback via the shared api-client (feedbackApi), with
// the current page URL/screen auto-attached so an admin knows where it came from.
import { useCallback, useRef, useState } from "react";
import { Modal, Form, FormField, Textarea, Select, Button, Icon } from "@dub/ui";
import type { SelectOption } from "@dub/ui";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { capturePageContext, submitFeedback } from "./feedbackApi.tsx";
import type { FeedbackCategory } from "./feedbackApi.tsx";

// Values MUST be members of the backend FEEDBACK_CATEGORIES enum (bug|idea|question|
// other); "改善要望" maps to "idea" (a value outside the enum 400s on submit).
const CATEGORY_OPTIONS: SelectOption<FeedbackCategory>[] = [
  { value: "bug", label: "バグ・不具合" },
  { value: "idea", label: "改善要望" },
  { value: "other", label: "その他" },
];

type SubmitStatus = "idle" | "submitting" | "success" | "error";

const MESSAGE_ID = "fe2-feedback-message";
const CATEGORY_ID = "fe2-feedback-category";

export interface FeedbackWidgetProps {
  api: ApiClient;
}

export function FeedbackWidget({ api }: FeedbackWidgetProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("other");
  const [status, setStatus] = useState<SubmitStatus>("idle");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const fabRef = useRef<HTMLButtonElement>(null);

  const reset = useCallback(() => {
    setMessage("");
    setCategory("other");
    setStatus("idle");
    setErrorText(null);
    setFieldError(null);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    reset();
    // Return focus to the trigger for keyboard/screen-reader continuity.
    fabRef.current?.focus();
  }, [reset]);

  const handleSubmit = useCallback(async () => {
    if (status === "submitting") return;
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      setFieldError("内容を入力してください。");
      return;
    }
    setFieldError(null);
    setErrorText(null);
    setStatus("submitting");
    try {
      await submitFeedback(api, { message: trimmed, category, ...capturePageContext() });
      setStatus("success");
    } catch (e) {
      setStatus("error");
      setErrorText(ApiError.isApiError(e) ? toDisplayableError(e).message : "送信に失敗しました。時間をおいて再度お試しください。");
    }
  }, [api, category, message, status]);

  const ctx = open ? capturePageContext() : null;

  return (
    <div className="fe2-feedback-root">
      <button
        ref={fabRef}
        type="button"
        className="fe2-feedback-fab"
        data-testid="fe2-feedback-fab"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="フィードバックを送る"
        title="フィードバックを送る"
        onClick={() => setOpen(true)}
      >
        <Icon name="message-circle" aria-label="フィードバック" />
      </button>

      <Modal
        open={open}
        onClose={close}
        title="フィードバックを送る"
        size="sm"
        testId="fe2-feedback-panel"
      >
        {status === "success" ? (
          <div className="fe2-feedback-done" data-testid="fe2-feedback-success">
            <span className="fe2-feedback-done-mark" aria-hidden="true">
              <Icon name="check" />
            </span>
            <p className="fe2-feedback-done-title">送信しました。ありがとうございます！</p>
            <p className="fe2-feedback-done-sub">いただいた内容は運営が確認します。</p>
            <div className="fe2-feedback-actions">
              <Button testId="fe2-feedback-close" variant="secondary" onClick={close}>
                閉じる
              </Button>
            </div>
          </div>
        ) : (
          <Form testId="fe2-feedback-form" onSubmit={handleSubmit}>
            <p className="fe2-feedback-lead">
              このアプリで気づいたこと（直してほしい所・要望など）をお知らせください。
            </p>
            <FormField
              label="内容"
              htmlFor={MESSAGE_ID}
              required
              {...(fieldError ? { error: fieldError } : {})}
            >
              <Textarea
                id={MESSAGE_ID}
                testId="fe2-feedback-message"
                value={message}
                onChange={setMessage}
                rows={5}
                placeholder="例：イベント一覧の並び順を新しい順にしてほしい"
              />
            </FormField>
            <FormField label="カテゴリ" htmlFor={CATEGORY_ID}>
              <Select<FeedbackCategory>
                id={CATEGORY_ID}
                testId="fe2-feedback-category"
                value={category}
                onChange={setCategory}
                options={CATEGORY_OPTIONS}
              />
            </FormField>

            {ctx ? (
              <p className="fe2-feedback-context" data-testid="fe2-feedback-context">
                <Icon name="info" size="sm" aria-label="送信元ページ" />
                <span>
                  送信元: <span className="fe2-feedback-context-page">{ctx.screenName}</span>
                  <span className="fe2-feedback-context-path">（{ctx.pagePath}）</span>
                </span>
              </p>
            ) : null}

            {errorText ? (
              <p className="fe2-feedback-error" role="alert" data-testid="fe2-feedback-error">
                {errorText}
              </p>
            ) : null}

            <div className="fe2-feedback-actions">
              <Button
                testId="fe2-feedback-cancel"
                variant="secondary"
                type="button"
                onClick={close}
                disabled={status === "submitting"}
              >
                キャンセル
              </Button>
              <Button
                testId="fe2-feedback-submit"
                type="submit"
                loading={status === "submitting"}
                iconLeft={<Icon name="message-circle" />}
              >
                送信
              </Button>
            </div>
          </Form>
        )}
      </Modal>
    </div>
  );
}
