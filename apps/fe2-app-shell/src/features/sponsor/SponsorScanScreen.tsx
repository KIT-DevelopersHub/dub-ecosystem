// スポンサー → 名刺をスキャン (/sponsor/scan)。撮影 (or 写真を選ぶ) → 写真の下で項目を入力 → 保存。
// 保存は楽観的: 一覧に先に足してすぐ戻り、裏で登録 → 写真を送信 (sponsorHooks.useSaveCard)。
// 前回の保存が失敗していたら、その入力と写真を復元して開く。
// 撮った写真は端末内で文字を読み取り (cardOcr)、空欄の項目に下書きとして入れる。手で入れた・直した値は上書きしない。
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, EmptyState, PageHeader, Spinner, Stack } from "@dub/ui";
import { DraftRestoredNotice } from "@dub/app-ui";
import { CardCapture } from "./CardCapture.tsx";
import { readCard } from "./cardOcr.ts";
import { mergeDraft, type CardDraft } from "./parseCardText.ts";
import { useCompanies, useObjectUrl, useSaveCard } from "./sponsorHooks.ts";
import { useSponsorPending } from "./SponsorProvider.tsx";
import { CardForm, EMPTY_FORM, formFromCard, SHARE_NOTICE, useSponsorCapability, type CardFormValues } from "./SponsorShared.tsx";
import styles from "./sponsor.module.css";

const LIST_PATH = "/sponsor";

type Step = { kind: "capture" } | { kind: "form"; image: Blob | null };

type Ocr =
  | { kind: "idle" }
  | { kind: "reading"; progress: number }
  | { kind: "done"; filled: number }
  | { kind: "failed" };

/** 写真の文字を読み取って form の空欄に入れる。run (毎回新しいオブジェクト) が変わるたびに読み直し、画面を離れたら中断する。 */
function useCardOcr(run: { image: Blob } | null, form: CardFormValues, setForm: (f: CardFormValues) => void): Ocr {
  const [ocr, setOcr] = useState<Ocr>({ kind: "idle" });
  const formRef = useRef(form);
  formRef.current = form;
  // 前回の読み取りで入れた値。撮り直したら、手を加えていない項目は新しい写真の結果で置き換える。
  const autoRef = useRef<CardDraft>({});
  useEffect(() => {
    if (!run) {
      setOcr({ kind: "idle" });
      return;
    }
    const ac = new AbortController();
    setOcr({ kind: "reading", progress: 0 });
    readCard(run.image, (progress) => !ac.signal.aborted && setOcr({ kind: "reading", progress }), ac.signal).then(
      ({ draft }) => {
        if (ac.signal.aborted) return;
        const { next, filled } = mergeDraft(formRef.current, draft, autoRef.current);
        autoRef.current = Object.fromEntries(filled.map((k) => [k, next[k]]));
        setForm(next);
        setOcr(Object.keys(draft).length > 0 ? { kind: "done", filled: filled.length } : { kind: "failed" });
      },
      () => !ac.signal.aborted && setOcr({ kind: "failed" }),
    );
    return () => ac.abort();
  }, [run, setForm]);
  return ocr;
}

function OcrStatus({ ocr, onRead, onCancel }: { ocr: Ocr; onRead: (() => void) | null; onCancel: () => void }): JSX.Element | null {
  if (ocr.kind === "idle") {
    return onRead ? (
      <div className={styles.ocrStatus} data-testid="fe2-sponsor-ocr-idle">
        <span className={styles.ocrText}>写真から会社名・氏名・連絡先などを読み取って、空いている項目に入力できます。</span>
        <Button variant="secondary" size="sm" testId="fe2-sponsor-ocr-start" onClick={onRead}>
          写真から読み取る
        </Button>
      </div>
    ) : null;
  }
  if (ocr.kind === "reading") {
    return (
      <div className={styles.ocrStatus} role="status" data-testid="fe2-sponsor-ocr-status">
        <Spinner size="sm" aria-label="読み取り中" />
        <span className={styles.ocrText}>名刺の文字を読み取っています… {Math.round(ocr.progress * 100)}%（初回は準備に少し時間がかかります）</span>
        <Button variant="ghost" size="sm" testId="fe2-sponsor-ocr-cancel" onClick={onCancel}>
          読み取りをやめる
        </Button>
      </div>
    );
  }
  if (ocr.kind === "done") {
    return (
      <p className={styles.ocrStatus} role="status" data-testid="fe2-sponsor-ocr-done">
        <span className={styles.ocrText}>
          {ocr.filled > 0
            ? `写真から読み取った内容を ${ocr.filled} 項目に入力しました。写真と見比べて確認してください。`
            : "写真から読み取りましたが、空いている項目はありませんでした。"}
        </span>
      </p>
    );
  }
  return (
    <div className={styles.ocrStatus} role="status" data-tone="warning" data-testid="fe2-sponsor-ocr-failed">
      <span className={styles.ocrText}>写真から文字を読み取れませんでした。手で入力してください。</span>
      <Button variant="secondary" size="sm" testId="fe2-sponsor-ocr-retry" onClick={onRead ?? undefined}>
        もう一度読み取る
      </Button>
    </div>
  );
}

export function SponsorScanScreen(): JSX.Element {
  const navigate = useNavigate();
  const pending = useSponsorPending();
  const { canWrite } = useSponsorCapability();
  const save = useSaveCard();
  const { companies } = useCompanies();
  // 失敗した下書きは開いた瞬間に 1 度だけ取り込む。
  const [restored] = useState(() => pending.get().draft);
  const [restoredVisible, setRestoredVisible] = useState(restored !== null);
  const [step, setStep] = useState<Step>(() => (restored ? { kind: "form", image: restored.image } : { kind: "capture" }));
  const [form, setForm] = useState<CardFormValues>(() => (restored ? formFromCard(restored.fields) : EMPTY_FORM));
  const photoUrl = useObjectUrl(step.kind === "form" ? step.image : null);
  // 撮った (選んだ) 写真だけ読み取る。復元した下書きは入力済みなので読まない。
  const [ocrRun, setOcrRun] = useState<{ image: Blob } | null>(null);
  const ocr = useCardOcr(ocrRun, form, setForm);
  const back = () => void navigate({ to: LIST_PATH });
  // 写真も項目も無い名刺は保存させない。
  const canSave = step.kind === "form" && (step.image !== null || Object.values(form).some((v) => v.trim() !== ""));

  const header = (
    <PageHeader
      testId="fe2-sponsor-scan-header"
      title="名刺をスキャン"
      actions={
        <Button variant="ghost" testId="fe2-sponsor-scan-back" onClick={back}>
          一覧へ戻る
        </Button>
      }
    />
  );

  if (!canWrite) {
    return (
      <div className={styles.page}>
        <Stack gap={6} testId="fe2-sponsor-scan-screen">
          {header}
          <EmptyState
            testId="fe2-sponsor-scan-forbidden"
            icon="lock"
            title="名刺を登録する権限がありません"
            description="登録が必要なときは、スポンサーチームの管理者に依頼してください。"
          />
        </Stack>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Stack gap={5} testId="fe2-sponsor-scan-screen">
        {header}
        <p className={styles.shareNotice} data-testid="fe2-sponsor-share-notice">
          {SHARE_NOTICE}
        </p>
        <DraftRestoredNotice
          testId="fe2-sponsor-restored"
          visible={restoredVisible && step.kind === "form"}
          message="前回保存できなかった入力を復元しました。"
          onKeep={() => setRestoredVisible(false)}
          onDiscard={() => {
            pending.setDraft(null);
            setOcrRun(null);
            setForm(EMPTY_FORM);
            setStep({ kind: "capture" });
            setRestoredVisible(false);
          }}
        />

        {step.kind === "capture" ? (
          <CardCapture
            onConfirm={(image) => {
              setStep({ kind: "form", image });
              setOcrRun({ image });
            }}
            extraAction={
              <Button variant="ghost" size="lg" testId="fe2-sponsor-skip-photo" onClick={() => setStep({ kind: "form", image: null })}>
                写真なしで入力
              </Button>
            }
          />
        ) : (
          // <form> にしない: スマホの改行キー (次の項目へ) で途中保存されるのを防ぐ。
          <div className={styles.scanForm} data-testid="fe2-sponsor-scan-form">
            <div className={styles.scanPhoto}>
              {photoUrl ? (
                <img src={photoUrl} alt="登録する名刺" className={styles.previewImg} data-testid="fe2-sponsor-scan-photo" />
              ) : (
                <div className={`${styles.photo} ${styles.photoEmpty}`}>写真なし</div>
              )}
              <Button
                variant="secondary"
                testId="fe2-sponsor-scan-retake"
                onClick={() => {
                  setOcrRun(null);
                  setStep({ kind: "capture" });
                }}
              >
                {step.image ? "撮り直す" : "写真を撮る"}
              </Button>
            </div>
            <OcrStatus
              ocr={ocr}
              onRead={step.image ? () => step.image && setOcrRun({ image: step.image }) : null}
              onCancel={() => setOcrRun(null)}
            />
            <p className={styles.note}>項目はすべて任意です。写真だけでも保存できます。</p>
            <CardForm idPrefix="sponsor-new" value={form} onChange={setForm} companies={companies.map((c) => c.name)} />
            <div className={styles.submitBar}>
              <Button
                size="lg"
                testId="fe2-sponsor-save"
                disabled={!canSave}
                onClick={() => {
                  void save(form, step.image);
                  back();
                }}
              >
                保存する
              </Button>
            </div>
          </div>
        )}
      </Stack>
    </div>
  );
}
