// スポンサー → 名刺をスキャン (/sponsor/scan)。撮影 (or 写真を選ぶ) → 写真の下で項目を入力 → 保存。
// 保存は楽観的: 一覧に先に足してすぐ戻り、裏で登録 → 写真を送信 (sponsorHooks.useSaveCard)。
// 前回の保存が失敗していたら、その入力と写真を復元して開く。
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, EmptyState, PageHeader, Stack } from "@dub/ui";
import { CardCapture } from "./CardCapture.tsx";
import { useObjectUrl, useSaveCard } from "./sponsorHooks.ts";
import { useSponsorPending } from "./SponsorProvider.tsx";
import { CardForm, EMPTY_FORM, formFromCard, SHARE_NOTICE, useSponsorCapability, type CardFormValues } from "./SponsorShared.tsx";
import styles from "./sponsor.module.css";

const LIST_PATH = "/sponsor";

type Step = { kind: "capture" } | { kind: "form"; image: Blob | null };

export function SponsorScanScreen(): JSX.Element {
  const navigate = useNavigate();
  const pending = useSponsorPending();
  const { canWrite } = useSponsorCapability();
  const save = useSaveCard();
  // 失敗した下書きは開いた瞬間に 1 度だけ取り込む。
  const [restored] = useState(() => pending.get().draft);
  const [step, setStep] = useState<Step>(() => (restored ? { kind: "form", image: restored.image } : { kind: "capture" }));
  const [form, setForm] = useState<CardFormValues>(() => (restored ? formFromCard(restored.fields) : EMPTY_FORM));
  const photoUrl = useObjectUrl(step.kind === "form" ? step.image : null);
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
        {restored && step.kind === "form" ? (
          <p className={styles.note} role="status" data-testid="fe2-sponsor-restored">
            前回保存できなかった入力を復元しました。
          </p>
        ) : null}

        {step.kind === "capture" ? (
          <CardCapture
            onConfirm={(image) => setStep({ kind: "form", image })}
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
              <Button variant="secondary" testId="fe2-sponsor-scan-retake" onClick={() => setStep({ kind: "capture" })}>
                {step.image ? "撮り直す" : "写真を撮る"}
              </Button>
            </div>
            <p className={styles.note}>項目はすべて任意です。写真だけでも保存できます。</p>
            <CardForm idPrefix="sponsor-new" value={form} onChange={setForm} />
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
