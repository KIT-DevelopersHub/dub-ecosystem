// LP管理 → 受付。当日、受付係がスマホで参加者のチケット QR を読んで受付済みにする画面。
//
// 設計メモ:
//  - 権限は app:lp:view + lp:checkin（購入者一覧の edit は要らない）。lp:checkin が無ければ説明だけ出す。
//  - スマホ前提（縦 1 列）。上から「受付日と人数」→「カメラ + 結果（大きく色分け・カメラの直下）」→「手入力」→「最近の受付」。
//    カメラは画面の 4 割までに抑え、かざしたまま結果が同じ画面に見えるようにする。
//  - 結果は OK（緑）/ 受付済み（黄）/ 無効・別日・不明（赤）。OK の直後だけ「取り消す」（読み間違え用）。
//  - 楽観的 UI: 読んだ瞬間に人数を +1 し、ok でなければ戻す。取り消しは一覧から先に外す。
//  - 受付日は既定で今日（JST）。前日の確認などのために日付を変えられる。
import { useCallback, useRef, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Form, FormField, PageHeader, SkeletonList, Stack, TextField } from "@dub/ui";
import { usePermissions } from "../../auth/AuthProvider.tsx";
import type { LpTicketCheckinResponse } from "./lpApi.tsx";
import { useCheckinTicket, useTicketCheckins, useUndoCheckin } from "./lpCheckinHooks.ts";
import { attendeeName, checkinView, formatEventDay, formatTimeJst, normalizeManualCode, shouldAcceptScan } from "./lpCheckin.ts";
import { todayJst } from "./lpTickets.ts";
import { LpTabs } from "./LpTabs.tsx";
import { QrScanner } from "./QrScanner.tsx";
import styles from "./lpCheckin.module.css";

export function LpCheckinScreen(): JSX.Element {
  const { can } = usePermissions();
  const allowed = can("lp:checkin");
  return (
    <div data-testid="fe2-lp-checkin-screen">
      <LpTabs active="checkin" />
      <PageHeader title="受付" description="参加者のチケット QR を読んで受付済みにします。同じ券は 1 日 1 回です。" />
      {allowed ? (
        <CheckinBody />
      ) : (
        <EmptyState
          testId="fe2-lp-checkin-forbidden"
          icon="lock"
          title="受付の権限がありません"
          description="ロール管理 > LP管理 の詳細で「チケットの当日受付（lp:checkin）」を付けてもらってください。"
        />
      )}
    </div>
  );
}

function CheckinBody(): JSX.Element {
  const [day, setDay] = useState(() => todayJst());
  const [camera, setCamera] = useState(true);
  const [manual, setManual] = useState("");
  const [last, setLast] = useState<LpTicketCheckinResponse | null>(null);
  const lastScan = useRef<{ code: string; at: number } | null>(null);
  const list = useTicketCheckins(day);
  const checkin = useCheckinTicket(day);
  const undo = useUndoCheckin(day);

  const submit = useCallback(
    (code: string) => {
      if (checkin.isPending) return;
      checkin.mutate(
        { code },
        {
          onSuccess: (res) => {
            setLast(res);
            if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(res.result === "ok" ? 80 : [60, 60, 60]);
          },
        },
      );
    },
    [checkin],
  );

  const onScan = useCallback(
    (raw: string) => {
      const now = Date.now();
      if (!shouldAcceptScan(raw, lastScan.current, now)) return;
      lastScan.current = { code: raw.trim(), at: now };
      submit(raw.trim());
    },
    [submit],
  );

  const onManual = () => {
    const code = normalizeManualCode(manual);
    if (!code) return;
    submit(code);
    setManual("");
  };

  const count = list.data?.count ?? 0;
  const view = last && last.eventDay === day ? checkinView(last) : null;

  return (
    <Stack gap={5} testId="fe2-lp-checkin-body">
      <Card testId="fe2-lp-checkin-summary">
        <div className={styles.summary}>
          <div>
            <label className={styles.dayLabel} htmlFor="fe2-lp-checkin-day">
              受付日
            </label>
            <input
              id="fe2-lp-checkin-day"
              data-testid="fe2-lp-checkin-day"
              className={styles.dayInput}
              type="date"
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
            />
          </div>
          <div className={styles.count} aria-live="polite">
            {list.isLoading ? (
              <span className={styles.countSkeleton} data-testid="fe2-lp-checkin-count-loading" aria-label="読み込み中" />
            ) : (
              <span className={styles.countNumber} data-testid="fe2-lp-checkin-count">
                {count}
              </span>
            )}
            <span className={styles.countUnit}>人 受付済み（{formatEventDay(day)}）</span>
          </div>
        </div>
      </Card>

      <Card
        testId="fe2-lp-checkin-scanner"
        header={
          <div className={styles.cardHeader}>
            <span>カメラで読む</span>
            <Button variant="secondary" size="sm" testId="fe2-lp-checkin-camera-toggle" onClick={() => setCamera((v) => !v)}>
              {camera ? "カメラを止める" : "カメラを使う"}
            </Button>
          </div>
        }
      >
        <div className={styles.scanArea}>
          <QrScanner paused={!camera} onCode={onScan} />
        <div className={styles.result} data-tone={checkin.isPending ? "pending" : (view?.tone ?? "idle")} data-testid="fe2-lp-checkin-result" aria-live="assertive">
          {checkin.isPending ? (
            <p className={styles.resultTitle}>確認しています…</p>
          ) : view ? (
            <>
              <p className={styles.resultTitle} data-testid="fe2-lp-checkin-result-title">
                {view.title}
              </p>
              {view.name ? <p className={styles.resultName}>{view.name} さん</p> : null}
              {view.ticketLabel ? <p className={styles.resultMeta}>{view.ticketLabel}</p> : null}
              {view.detail ? <p className={styles.resultMeta}>{view.detail}</p> : null}
              {view.canUndo && last?.ticket ? (
                <div className={styles.resultActions}>
                  <Button
                    variant="secondary"
                    size="sm"
                    testId="fe2-lp-checkin-result-undo"
                    onClick={() => {
                      undo.mutate({ ticketId: last.ticket!.ticketId });
                      setLast(null);
                    }}
                  >
                    この受付を取り消す
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <p className={styles.resultIdle}>QR を枠に合わせると、ここに結果が出ます</p>
          )}
        </div>
        </div>
      </Card>

      <Card testId="fe2-lp-checkin-manual">
        <Form onSubmit={onManual} testId="fe2-lp-checkin-manual-form">
          <FormField label="手入力" htmlFor="fe2-lp-checkin-code" help="注文番号-枚目（例 ABCD1234-1）、またはチケットの URL">
            <div className={styles.manualRow}>
              <TextField id="fe2-lp-checkin-code" testId="fe2-lp-checkin-code" value={manual} placeholder="ABCD1234-1" onChange={setManual} />
              <Button type="submit" testId="fe2-lp-checkin-submit" disabled={!normalizeManualCode(manual)} loading={checkin.isPending}>
                受付
              </Button>
            </div>
          </FormField>
        </Form>
      </Card>

      <Card testId="fe2-lp-checkin-list" header={<span>最近の受付</span>}>
        {list.isLoading ? (
          <SkeletonList rows={4} testId="fe2-lp-checkin-list-loading" />
        ) : list.isError || !list.data ? (
          <ErrorState
            testId="fe2-lp-checkin-list-error"
            error={{ code: "INTERNAL", message: "受付一覧を読み込めませんでした。" }}
            onRetry={() => void list.refetch()}
          />
        ) : list.data.items.length === 0 ? (
          <EmptyState testId="fe2-lp-checkin-list-empty" icon="users" title="まだ受付はありません" />
        ) : (
          <ul className={styles.list}>
            {list.data.items.map((i) => (
              <li key={i.ticketId} className={styles.row} data-testid={`fe2-lp-checkin-row-${i.ticketId}`}>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>{attendeeName(i)}</span>
                  <span className={styles.rowMeta}>
                    {i.ticketTypeName} · {i.orderRef} · {formatTimeJst(i.checkedInAt)}
                  </span>
                </div>
                <Button variant="ghost" size="sm" testId={`fe2-lp-checkin-undo-${i.ticketId}`} onClick={() => undo.mutate({ ticketId: i.ticketId })}>
                  取り消す
                </Button>
              </li>
            ))}
          </ul>
        )}
        {list.data && list.data.days.length > 1 ? (
          <div className={styles.days} data-testid="fe2-lp-checkin-days">
            {list.data.days.map((d) => (
              <Badge key={d.eventDay} tone={d.eventDay === day ? "brand" : "neutral"}>
                {formatEventDay(d.eventDay)} {d.count} 人
              </Badge>
            ))}
          </div>
        ) : null}
      </Card>
    </Stack>
  );
}
