// 「面談結果を登録」ダイアログ (面談確定・面談済みの応募者)。
//  1. 入力: 合否・理由 (必須・社内の記録)・理由をメールに含めるか (既定 OFF)・合格なら発行するアドレス。
//     下にメールのプレビュー (送る文面と同じ @dub/types hrResult.renderResultMail)。
//  2. 確認: 送り先と、合格ならアカウント発行を明示してから送る。
// 送信は非楽観 (アカウント発行とメールを伴う)。サーバーが応募者ごとに 1 件に絞るので、二度押ししても 1 回だけ。
import { useMemo, useRef, useState } from "react";
import { Button, Checkbox, FormField, Modal, SegmentedControl, TextField, Textarea, useToast } from "@dub/ui";
import { hrForm, hrResult, type hr } from "@dub/types";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { kanaToRomaji } from "../../lib/romaji.ts";
import { useRegisterInterviewResult } from "./hrHooks.ts";
import styles from "./hr.module.css";

export const MAIL_DOMAIN = "developershub.jp";

/** 参加届からの発行と同じ命名 (名.姓 のローマ字)。フリガナが無ければ空 (人事が入れる)。 */
export function suggestLocalPart(nameKana: string | null): string {
  const parts = (nameKana ?? "").trim().split(/[\s　]+/).filter(Boolean);
  const clean = (v: string): string => kanaToRomaji(v).toLowerCase().replace(/[^a-z]/g, "");
  const [last, first] = parts.length >= 2 ? [clean(parts[0]!), clean(parts.slice(1).join(""))] : [clean(parts[0] ?? ""), ""];
  if (first && last) return `${first}.${last}`;
  return first || last;
}

/** 結果を登録できる人 (面談確定・面談済み)。 */
export function canRegisterResult(a: hr.Applicant): boolean {
  return hrResult.RESULT_STAGES.includes(a.stage);
}

function errorMessage(err: unknown): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : "登録できませんでした";
}

export function InterviewResultDialog({ applicant, onClose }: { applicant: hr.Applicant | null; onClose: () => void }): JSX.Element | null {
  if (!applicant) return null;
  return <ResultForm key={applicant.id} applicant={applicant} onClose={onClose} />;
}

function ResultForm({ applicant: a, onClose }: { applicant: hr.Applicant; onClose: () => void }): JSX.Element {
  const register = useRegisterInterviewResult();
  const toast = useToast();
  const [decision, setDecision] = useState<hrResult.InterviewDecision | null>(null);
  const [reason, setReason] = useState("");
  const [includeReason, setIncludeReason] = useState(false);
  const [localPart, setLocalPart] = useState(() => suggestLocalPart(a.nameKana));
  const [step, setStep] = useState<"input" | "confirm">("input");
  // isPending は次の描画まで立たないので、同じ描画内の二度押しはここで止める (サーバーも 1 件に絞る)。
  const sending = useRef(false);

  const address = `${localPart.trim().toLowerCase()}@${MAIL_DOMAIN}`;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const preview = useMemo(() => {
    if (!decision) return null;
    return hrResult.renderResultMail({
      decision,
      name: a.name,
      reason: includeReason ? reason : null,
      address,
      appUrl: `${origin}/`,
      participationUrl: `${origin}${hrForm.PUBLIC_PARTICIPATION_PATH}#prefill=…`,
      onboardingUrl: `${origin}${hrResult.PUBLIC_ONBOARDING_PATH}`,
    });
  }, [decision, a.name, includeReason, reason, address, origin]);

  const ready = decision !== null && reason.trim() !== "" && (decision === "fail" || localPart.trim() !== "") && !!a.email;

  const submit = (): void => {
    if (!decision || sending.current) return;
    sending.current = true;
    register.mutate(
      {
        applicantId: a.id,
        body: { decision, reason: reason.trim(), includeReasonInMail: includeReason, ...(decision === "pass" ? { localPart: localPart.trim().toLowerCase() } : {}) },
      },
      {
        onSuccess: (res) => {
          const title = res.alreadyRegistered
            ? "この応募者の結果は登録済みです（何も送っていません）"
            : decision === "pass"
              ? `合格を登録し、${a.email} にメールを送りました`
              : `不合格を登録し、${a.email} にメールを送りました`;
          toast.show({
            kind: res.alreadyRegistered ? "info" : "success",
            title,
            ...(decision === "pass" && !res.alreadyRegistered
              ? { description: res.accountMailSent ? "ログイン情報のメールも送りました" : "ログイン情報のメールは送れませんでした。ユーザー名簿から送り直してください" }
              : {}),
          });
          onClose();
        },
        onError: () => setStep("input"),
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  };

  const footer =
    step === "input" ? (
      <>
        <Button variant="ghost" onClick={onClose} testId="fe2-hr-result-cancel">
          キャンセル
        </Button>
        <Button variant="primary" disabled={!ready} onClick={() => setStep("confirm")} testId="fe2-hr-result-next">
          確認へ
        </Button>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={() => setStep("input")} disabled={register.isPending} testId="fe2-hr-result-back">
          戻る
        </Button>
        <Button
          variant={decision === "fail" ? "danger" : "primary"}
          onClick={submit}
          loading={register.isPending}
          disabled={register.isPending}
          testId="fe2-hr-result-submit"
        >
          {decision === "pass" ? "アカウントを発行して送信" : "送信する"}
        </Button>
      </>
    );

  return (
    <Modal open onClose={register.isPending ? () => undefined : onClose} title={`面談結果を登録: ${a.name}`} size="lg" footer={footer} testId="fe2-hr-result-dialog">
      {step === "input" ? (
        <div className={styles.detail}>
          <SegmentedControl<hrResult.InterviewDecision>
            caption="合否"
            aria-label="合否"
            value={decision}
            onChange={(d) => setDecision(d)}
            options={hrResult.INTERVIEW_DECISIONS.map((d) => ({ value: d, label: hrResult.DECISION_LABELS[d], testId: `fe2-hr-result-decision-${d}` }))}
            testId="fe2-hr-result-decision"
          />
          <FormField label="理由" htmlFor="hr-result-reason" required help="社内の記録として履歴に残ります。">
            <Textarea id="hr-result-reason" testId="fe2-hr-result-reason" rows={3} value={reason} onChange={setReason} />
          </FormField>
          <Checkbox
            id="hr-result-include-reason"
            testId="fe2-hr-result-include-reason"
            checked={includeReason}
            onChange={setIncludeReason}
            label="理由をメールに含める（応募者に届きます）"
          />
          {decision === "pass" ? (
            <FormField label="発行するメールアドレス" htmlFor="hr-result-localpart" help="フリガナのローマ字から作った案です。必要なら書き換えてください。">
              <div className={styles.mailRow}>
                <TextField id="hr-result-localpart" testId="fe2-hr-result-localpart" value={localPart} onChange={setLocalPart} placeholder="taro.yamada" />
                <span className={styles.mailSuffix}>@{MAIL_DOMAIN}</span>
              </div>
            </FormField>
          ) : null}
          {!a.email ? (
            <p className={styles.resultAlert} role="alert" data-testid="fe2-hr-result-no-email">
              応募者のメールアドレスが無いため、結果を送れません。
            </p>
          ) : null}
          {register.isError ? (
            <p className={styles.resultAlert} role="alert" data-testid="fe2-hr-result-error">
              {errorMessage(register.error)}
            </p>
          ) : null}
          {preview ? (
            <div data-testid="fe2-hr-result-preview">
              <div className={styles.sectionTitle}>メールのプレビュー（宛先: {a.email ?? "—"}）</div>
              <div className={styles.mailPreview}>
                <div className={styles.mailSubject}>{preview.subject}</div>
                <pre className={styles.mailBody}>{preview.textBody}</pre>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className={styles.detail} data-testid="fe2-hr-result-confirm">
          <p>
            {a.name} さんを<strong>「{decision ? hrResult.DECISION_LABELS[decision] : ""}」</strong>として登録し、{a.email} に結果のメールを送ります。送ったメールは取り消せません。
          </p>
          {decision === "pass" ? (
            <ul className={styles.resultList}>
              <li>
                <strong>{address}</strong> のメールアドレスと Dub のアカウント（一般メンバー）を発行します
              </li>
              <li>運営メンバー・名簿に在籍として追加し、ステータスを「採用」にします</li>
              <li>初期パスワードは既存の「アカウント発行のお知らせ」メールで別に届きます</li>
            </ul>
          ) : (
            <ul className={styles.resultList}>
              <li>ステータスを「不合格」にします</li>
              <li>理由はメールに{includeReason ? "含めます" : "含めません（社内の記録だけに残ります）"}</li>
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
