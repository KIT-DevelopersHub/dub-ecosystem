// 面談の日程選択の PUBLIC ページ (/interview-book#t=<token>)。案内メールの URL から開く。応募者はアカウントを
// 持たないのでシェルの外に置く。トークンは fragment にあるのでサーバーログや Referer に載らない。
// 選ぶ操作は他の人と枠を取り合うので楽観的にせず、結果を待ってから確定画面を出す。
import { useMemo, useState } from "react";
import { Button, Card, EmptyState, ErrorState, SkeletonList } from "@dub/ui";
import { hrInterview } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { bookingErrorCode, interviewErrorMessage, InterviewsProvider, useBookSlot, usePublicBooking } from "./interviewsApi.tsx";
import styles from "./interviews.module.css";

function tokenFromHash(): string {
  return new URLSearchParams(globalThis.location?.hash.replace(/^#/, "") ?? "").get("t") ?? "";
}

export function PublicInterviewBookingPage({ api }: { api: ApiClient }): JSX.Element {
  const token = useMemo(tokenFromHash, []);
  return (
    <InterviewsProvider api={api}>
      <div className={styles.publicPage} data-testid="interview-booking-page">
        <div className={styles.publicInner}>
          <Card testId="interview-booking-hero">
            <h1 className={styles.publicTitle}>面談日程の選択</h1>
          </Card>
          <BookingBody token={token} />
        </div>
      </div>
    </InterviewsProvider>
  );
}

function Invalid(): JSX.Element {
  return (
    <EmptyState
      testId="interview-booking-invalid"
      icon="inbox"
      title="この URL は使えません"
      description="案内メールの URL をもう一度開いてください。解決しない場合は、メールに返信してお知らせください。"
    />
  );
}

function BookingBody({ token }: { token: string }): JSX.Element {
  const booking = usePublicBooking(token);
  if (!token) return <Invalid />;
  if (booking.isLoading) return <SkeletonList rows={5} testId="interview-booking-loading" />;
  if (bookingErrorCode(booking.error) === "HR_INVITE_NOT_FOUND") return <Invalid />;
  if (booking.isError || !booking.data) {
    const display = ApiError.isApiError(booking.error)
      ? toDisplayableError(booking.error)
      : { code: "UNKNOWN", message: "日程を読み込めませんでした" };
    return <ErrorState testId="interview-booking-error" error={display} onRetry={() => void booking.refetch()} />;
  }
  const { state, applicantName, slots, booked } = booking.data;
  if (state === "booked" && booked) {
    return (
      <Card testId="interview-booking-done">
        <div className={styles.thanks}>
          <p className={styles.thanksLead}>面談の日程を承りました</p>
          <p className={styles.bookedAt} data-testid="interview-booking-done-at">
            {hrInterview.formatSlotJst(booked)}（日本時間）
          </p>
          <p className={styles.muted}>確認メールをお送りしました。場所や参加方法は担当者からご連絡します。</p>
        </div>
      </Card>
    );
  }
  if (state === "closed") {
    return (
      <EmptyState
        testId="interview-booking-closed"
        icon="clock"
        title="ここから日程は選べません"
        description="すでに担当者が調整しています。ご不明な点は、案内メールに返信してお知らせください。"
      />
    );
  }
  return <SlotPicker token={token} name={applicantName} slots={slots} />;
}

function SlotPicker({ token, name, slots }: { token: string; name: string; slots: hrInterview.PublicInterviewSlot[] }): JSX.Element {
  const bookSlot = useBookSlot(token);
  const [picked, setPicked] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  if (slots.length === 0) {
    return (
      <EmptyState
        testId="interview-booking-empty"
        icon="clock"
        title="現在選べる日程がありません"
        description="担当者が日程を追加しています。少し時間をおいて、このページを開き直してください。"
      />
    );
  }
  const current = slots.some((s) => s.id === picked) ? picked : null;
  return (
    <Card testId="interview-booking-card">
      <p className={styles.lead}>{name} 様、ご都合のよい日時を 1 つ選んでください。</p>
      <div className={styles.slotList} role="radiogroup" aria-label="面談の日時">
        {slots.map((s) => (
          <label key={s.id} className={styles.slotOption} data-checked={s.id === current || undefined} data-testid={`interview-booking-slot-${s.id}`}>
            <input type="radio" name="interview-slot" checked={s.id === current} onChange={() => setPicked(s.id)} />
            <span>{hrInterview.formatSlotJst(s)}</span>
          </label>
        ))}
      </div>
      <p className={styles.muted}>時刻はすべて日本時間です。</p>
      {failure ? (
        <p className={styles.errorSummary} role="alert" data-testid="interview-booking-failure">
          {failure}
        </p>
      ) : null}
      <div className={styles.submitRow}>
        <Button
          testId="interview-booking-submit"
          disabled={current === null}
          loading={bookSlot.isPending}
          onClick={() => {
            if (current === null) return;
            setFailure(null);
            bookSlot.mutate(current, {
              onError: (err) => setFailure(interviewErrorMessage(err, "予約できませんでした。時間をおいてもう一度お試しください。")),
            });
          }}
        >
          この日時で予約する
        </Button>
      </div>
    </Card>
  );
}
