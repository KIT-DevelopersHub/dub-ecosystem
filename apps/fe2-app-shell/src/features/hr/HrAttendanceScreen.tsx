// 人事 → 出席。全体定例・チーム定例 (カレンダー > ミーティング で「出席を取る」にした定例) の出席。
// 出席は Google Meet の参加記録から自動で付く (各回の終了後に取り込み・毎時 + 「今すぐ取り込む」)。
// Meet の参加者は Google アカウントでメンバーと結びつく: 本人の「Googleと連携」か、ここで一度
// 「確定」したもの (記憶され次回から自動)。参加時間が「出席とみなす割合」以上なら出席。
//   上: Meet の状態 (再連携が必要か / 最終取り込み / 今すぐ取り込む / 割合の設定)
//   左: メンバー別の出席率 (低い順)
//   右: 定例ごと — 回を選ぶと各メンバーの出欠・参加時間、未確定の参加者 (候補から確定)
// 手修正は「自動」より優先 (楽観的 UI)。
import { useMemo, useState } from "react";
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, SegmentedControl, Select, SkeletonLoader, SkeletonTable } from "@dub/ui";
import { meeting } from "@dub/types";
import { useAttendanceSettings, useConfirmParticipant, useHrAttendance, useIngestAttendance, useSetAttendance } from "./hrHooks.ts";
import { HrFrame } from "./HrApplicantsScreen.tsx";
import { useHrCapability } from "./HrShared.tsx";
import styles from "./hr.module.css";

type Period = "4w" | "12w" | "26w";
type KindFilter = "all" | meeting.RegularMeetingKind;
type Choice = "auto" | meeting.AttendanceStatus;

const PERIOD_DAYS: Record<Period, number> = { "4w": 28, "12w": 84, "26w": 182 };
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];
const PERCENT_OPTIONS = [30, 50, 70, 80, 90];

/** JST today as YYYY-MM-DD. */
function jstToday(now = Date.now()): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function periodRange(period: Period, now = Date.now()): { from: string; to: string } {
  const to = jstToday(now);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (PERIOD_DAYS[period] - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

function dateLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${m}/${d}(${WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]})`;
}

const hm = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(11, 16);

/** 「21:02–21:58・56分」 */
export function presenceLabel(p: meeting.MeetPresence): string {
  const min = Math.round(p.durationSeconds / 60);
  return `${hm(p.firstJoin)}–${p.lastLeave ? hm(p.lastLeave) : "参加中"}・${p.approx ? "約" : ""}${min}分`;
}

function dateTimeLabel(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3_600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.toISOString().slice(11, 16)}`;
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function rateTone(rate: number | null): "success" | "warning" | "danger" | "neutral" {
  if (rate === null) return "neutral";
  if (rate >= 0.8) return "success";
  return rate >= 0.5 ? "warning" : "danger";
}

const STATUS_LABEL: Record<meeting.AttendanceStatus, string> = { present: "出席", excused: "欠席連絡", absent: "欠席" };
const STATUS_TONE: Record<meeting.AttendanceStatus, "success" | "info" | "neutral"> = { present: "success", excused: "info", absent: "neutral" };
const SOURCE_LABEL: Record<meeting.AttendanceSource, string> = { meet_api: "Meet", join: "Dub から参加", manual: "手修正" };

function ingestLabel(i: meeting.MeetIngestState | null): string {
  if (!i) return "Meet の記録: まだ取り込んでいません";
  if (i.status === "no_conference") return `Meet の記録: 会議が見つかりません（${dateTimeLabel(i.ingestedAt)}）`;
  if (i.status === "error") return `Meet の記録: 取り込みに失敗しました（自動で再試行します）`;
  return `Meet の記録: 取り込み済み（${dateTimeLabel(i.ingestedAt)}）`;
}

export function HrAttendanceScreen(): JSX.Element {
  const [period, setPeriod] = useState<Period>("12w");
  const [kind, setKind] = useState<KindFilter>("all");
  const range = useMemo(() => periodRange(period), [period]);
  const report = useHrAttendance(range);
  const setAttendance = useSetAttendance(range);
  const confirm = useConfirmParticipant(range);
  const settings = useAttendanceSettings(range);
  const ingest = useIngestAttendance();
  const { canWrite } = useHrCapability();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Record<string, string>>({});

  const toolbar = (
    <div className={styles.toolbar}>
      <SegmentedControl<KindFilter>
        aria-label="定例の種類"
        value={kind}
        onChange={setKind}
        testId="fe2-hr-att-kind"
        options={[
          { value: "all", label: "すべて" },
          { value: "all_hands", label: "全体定例" },
          { value: "team", label: "チーム定例" },
        ]}
      />
      <SegmentedControl<Period>
        aria-label="期間"
        value={period}
        onChange={setPeriod}
        testId="fe2-hr-att-period"
        options={[
          { value: "4w", label: "直近4週" },
          { value: "12w", label: "直近12週" },
          { value: "26w", label: "直近半年" },
        ]}
      />
    </div>
  );

  let body: JSX.Element;
  if (report.isLoading) {
    body = (
      <div className={styles.attLayout} data-testid="fe2-hr-att-loading">
        <Card>
          <SkeletonTable rows={5} columns={4} />
        </Card>
        <Card>
          <SkeletonLoader lines={6} />
        </Card>
      </div>
    );
  } else if (report.isError || !report.data) {
    body = (
      <ErrorState
        testId="fe2-hr-att-error"
        error={{ code: "INTERNAL", message: "出席を読み込めませんでした。" }}
        onRetry={() => void report.refetch()}
      />
    );
  } else {
    const data = report.data;
    const minPercent = data.settings.minPercent;
    const status = (
      <Card testId="fe2-hr-att-meet">
        <div className={styles.attStatus}>
          {data.meetApi.ready ? (
            <span className={styles.note} data-testid="fe2-hr-att-meet-ready">
              Meet の参加記録から自動で出席を付けています。
              {data.meetApi.lastRunAt ? `最終取り込み ${dateTimeLabel(data.meetApi.lastRunAt)}` : "まだ取り込んでいません。"}
            </span>
          ) : (
            <span className={styles.attAlert} role="alert" data-testid="fe2-hr-att-meet-missing">
              再連携が必要です: 共有の Google アカウントに Meet の参加記録を読む権限がありません。
              <a href="/driveshare?setting=google-account">Drive共有 → 設定</a> で「再接続」してください。
            </span>
          )}
          <span className={styles.attControls}>
            <span className={styles.note}>出席とみなす参加時間</span>
            {canWrite ? (
              <span className={styles.attSelect}>
                <Select<string>
                  id="att-min-percent"
                  testId="fe2-hr-att-min-percent"
                  value={String(minPercent)}
                  onChange={(v) => settings.mutate({ minPercent: Number(v) })}
                  options={[...new Set([...PERCENT_OPTIONS, minPercent])]
                    .sort((a, b) => a - b)
                    .map((n) => ({ value: String(n), label: `予定の ${n}% 以上` }))}
                />
              </span>
            ) : (
              <Badge tone="neutral">予定の {minPercent}% 以上</Badge>
            )}
            {canWrite ? (
              <Button
                size="sm"
                variant="secondary"
                loading={ingest.isPending}
                disabled={!data.meetApi.ready}
                onClick={() => ingest.mutate()}
                testId="fe2-hr-att-ingest"
              >
                今すぐ取り込む
              </Button>
            ) : null}
          </span>
        </div>
      </Card>
    );

    if (data.meetings.length === 0) {
      body = (
        <>
          {status}
          <EmptyState
            testId="fe2-hr-att-empty"
            icon="calendar"
            title="出席を取っている定例はありません"
            description="カレンダー > ミーティング で定例を作成・編集し、「出席を取る」をオンにすると、Meet の参加記録から出席がここに入ります。"
          />
        </>
      );
    } else {
      const meetings = data.meetings.filter((m) => kind === "all" || m.kind === kind);
      const nameOf = new Map(data.members.map((m) => [m.userId, m.name]));
      // メンバー別の率は選んだ種類の定例だけで数え直す (サーバの集計は全定例ぶん)。
      const members = data.members
        .map((mem) => {
          let expected = 0;
          let present = 0;
          let excused = 0;
          for (const m of meetings) {
            if (!m.expectedUserIds.includes(mem.userId)) continue;
            expected += m.occurrences.length;
            for (const o of m.occurrences) {
              const r = o.records.find((x) => x.userId === mem.userId);
              if (r?.status === "present") present++;
              else if (r?.status === "excused") excused++;
            }
          }
          const denom = expected - excused;
          return { ...mem, expected, present, excused, rate: denom > 0 ? present / denom : null };
        })
        .filter((m) => m.expected > 0)
        .sort((a, b) => (a.rate ?? 2) - (b.rate ?? 2) || a.name.localeCompare(b.name, "ja"));

      body = (
        <>
          {status}
          <div className={styles.attLayout}>
            <Card testId="fe2-hr-att-members" header={<span className={styles.cardName}>メンバー別の出席率</span>}>
              <DataTable
                testId="fe2-hr-att-member-table"
                rowKey={(r) => r.userId}
                rows={members}
                emptyState={<span className={styles.note}>この種類の定例の対象メンバーはいません。</span>}
                columns={[
                  { key: "name", header: "名前", cell: (r) => r.name, noWrap: true },
                  { key: "present", header: "出席", align: "right", noWrap: true, cell: (r) => `${r.present} / ${r.expected - r.excused} 回` },
                  { key: "excused", header: "欠席連絡", align: "right", noWrap: true, cell: (r) => (r.excused ? `${r.excused} 回` : "—") },
                  {
                    key: "rate",
                    header: "出席率",
                    align: "right",
                    noWrap: true,
                    cell: (r) => (
                      <span data-testid={`fe2-hr-att-rate-${r.userId}`}>
                        <Badge tone={rateTone(r.rate)}>{pct(r.rate)}</Badge>
                      </span>
                    ),
                  },
                ]}
              />
            </Card>

            <div className={styles.attMeetings}>
              {meetings.map((m) => {
                const date = selected[m.id] ?? m.occurrences[0]?.date ?? null;
                const occ = m.occurrences.find((o) => o.date === date) ?? null;
                const recOf = (userId: string) => occ?.records.find((x) => x.userId === userId) ?? null;
                const presentCount = occ ? m.expectedUserIds.filter((u) => recOf(u)?.status === "present").length : 0;
                const unmatched = occ ? occ.participants.filter((p) => !p.userId && p.kind === "signed_in" && p.googleUserId) : [];
                const guests = occ ? occ.participants.filter((p) => p.kind !== "signed_in") : [];
                const outsiders = occ ? occ.records.filter((r) => !m.expectedUserIds.includes(r.userId) && r.status === "present") : [];
                return (
                  <Card
                    key={m.id}
                    testId={`fe2-hr-att-meeting-${m.id}`}
                    header={
                      <div className={styles.obHeader}>
                        <span className={styles.cardName}>{m.title}</span>
                        <span className={styles.attTags}>
                          <Badge tone={m.kind === "all_hands" ? "brand" : "info"}>{meeting.REGULAR_KIND_LABELS[m.kind]}</Badge>
                          <span className={styles.note}>{m.targetName}</span>
                        </span>
                      </div>
                    }
                  >
                    {!occ ? (
                      <span className={styles.note}>この期間に開催された回はまだありません。</span>
                    ) : (
                      <div className={styles.obItems}>
                        <div className={styles.toolbar}>
                          <div className={styles.attSelect}>
                            <Select
                              id={`att-occ-${m.id}`}
                              testId={`fe2-hr-att-occ-${m.id}`}
                              value={occ.date}
                              onChange={(v) => setSelected((s) => ({ ...s, [m.id]: v }))}
                              options={m.occurrences.map((o) => ({ value: o.date, label: dateLabel(o.date) }))}
                            />
                          </div>
                          <span className={styles.note} data-testid={`fe2-hr-att-count-${m.id}`}>
                            出席 {presentCount} / {m.expectedUserIds.length} 人
                          </span>
                        </div>
                        <span className={styles.note} data-testid={`fe2-hr-att-ingest-${m.id}`}>
                          {ingestLabel(occ.ingest)}
                        </span>
                        <ul className={styles.attList}>
                          {m.expectedUserIds.map((userId) => {
                            const rec = recOf(userId);
                            const st = rec?.status ?? "absent";
                            const choice: Choice = rec?.source === "manual" ? rec.status : "auto";
                            return (
                              <li key={userId} className={styles.attRow} data-testid={`fe2-hr-att-${m.id}-${userId}`}>
                                <span className={styles.attName}>
                                  {nameOf.get(userId) ?? userId}
                                  <Badge tone={STATUS_TONE[st]} testId={`fe2-hr-att-status-${m.id}-${userId}`}>
                                    {STATUS_LABEL[st]}
                                  </Badge>
                                  {rec ? <span className={styles.note}>{SOURCE_LABEL[rec.source]}</span> : null}
                                  {rec?.meet ? (
                                    <span className={styles.note} data-testid={`fe2-hr-att-time-${m.id}-${userId}`}>
                                      {presenceLabel(rec.meet)}
                                    </span>
                                  ) : null}
                                </span>
                                {canWrite ? (
                                  <div className={styles.attSelect}>
                                    <Select<Choice>
                                      id={`att-${m.id}-${occ.date}-${userId}`}
                                      testId={`fe2-hr-att-set-${m.id}-${userId}`}
                                      value={choice}
                                      onChange={(v) =>
                                        setAttendance.mutate({ meetingId: m.id, date: occ.date, userId, status: v === "auto" ? null : v })
                                      }
                                      options={[
                                        { value: "auto", label: "自動（Meet）" },
                                        { value: "present", label: "出席にする" },
                                        { value: "excused", label: "欠席連絡あり" },
                                        { value: "absent", label: "欠席にする" },
                                      ]}
                                    />
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>

                        {unmatched.length > 0 ? (
                          <div className={styles.attUnmatched} data-testid={`fe2-hr-att-unmatched-${m.id}`}>
                            <span className={styles.cardName}>未確定の参加者（{unmatched.length}）</span>
                            <span className={styles.note}>Google アカウントがまだメンバーと結びついていません。一度確定すると次回から自動です。</span>
                            <ul className={styles.attList}>
                              {unmatched.map((p) => {
                                const gid = p.googleUserId!;
                                const suggested = new Set(p.suggestions.map((s) => s.userId));
                                const options = [
                                  ...p.suggestions.map((s) => ({ value: s.userId, label: `${s.name}（候補）` })),
                                  ...m.expectedUserIds.filter((u) => !suggested.has(u)).map((u) => ({ value: u, label: nameOf.get(u) ?? u })),
                                ];
                                const pick = picks[gid] ?? p.suggestions[0]?.userId ?? null;
                                return (
                                  <li key={p.key} className={styles.attRow} data-testid={`fe2-hr-att-unmatched-${m.id}-${gid}`}>
                                    <span className={styles.attName}>
                                      {p.displayName}
                                      <span className={styles.note}>{presenceLabel(p)}</span>
                                    </span>
                                    {canWrite ? (
                                      <span className={styles.attControls}>
                                        <span className={styles.attSelect}>
                                          <Select<string>
                                            id={`att-pick-${m.id}-${gid}`}
                                            testId={`fe2-hr-att-pick-${m.id}-${gid}`}
                                            value={pick}
                                            placeholder="メンバーを選ぶ"
                                            onChange={(v) => setPicks((s) => ({ ...s, [gid]: v }))}
                                            options={options}
                                          />
                                        </span>
                                        <Button
                                          size="sm"
                                          disabled={!pick}
                                          testId={`fe2-hr-att-confirm-${m.id}-${gid}`}
                                          onClick={() => pick && confirm.mutate({ googleUserId: gid, userId: pick, name: nameOf.get(pick) ?? pick })}
                                        >
                                          確定
                                        </Button>
                                      </span>
                                    ) : (
                                      <Badge tone="warning">未確定</Badge>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ) : null}
                        {guests.length > 0 ? (
                          <span className={styles.note} data-testid={`fe2-hr-att-guests-${m.id}`}>
                            ゲスト（Google 未ログイン・電話）: {guests.map((g) => `${g.displayName}（${Math.round(g.durationSeconds / 60)}分）`).join("、")}
                          </span>
                        ) : null}
                        {outsiders.length > 0 ? (
                          <span className={styles.note}>対象外の参加: {outsiders.map((g) => nameOf.get(g.userId) ?? g.userId).join("、")}</span>
                        ) : null}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          </div>
        </>
      );
    }
  }

  return (
    <HrFrame active="attendance">
      <>
        <span className={styles.note}>
          カレンダー › ミーティング で「出席を取る」にした定例が対象です。各回の終了後に Google Meet の参加記録を取り込み、参加時間が設定の割合以上のメンバーを出席にします。Google
          アカウントが分からない参加者は「未確定」に出るので、一度確定してください。
        </span>
        {toolbar}
        {body}
      </>
    </HrFrame>
  );
}
