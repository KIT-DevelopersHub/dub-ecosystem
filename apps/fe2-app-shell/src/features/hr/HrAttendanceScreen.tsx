// 人事 → 出席。全体定例・チーム定例 (カレンダー > ミーティング で「出席を取る」にした定例) の出席。
// Dub (ダッシュボードの「定例に参加」/ カレンダー) から Meet に入った人が自動で出席になる。
//   上: メンバー別の出席率 (低い順) — 出席 / 対象回数、欠席連絡
//   下: 定例ごと — 回 (日付) を選ぶと対象メンバーの 出席 / 欠席連絡 / 欠席。人事 編集 + hr:write なら
//       その場で直せる (楽観的 UI)。
import { useMemo, useState } from "react";
import { Badge, Card, DataTable, EmptyState, ErrorState, SegmentedControl, Select, SkeletonLoader, SkeletonTable } from "@dub/ui";
import { meeting } from "@dub/types";
import { useHrAttendance, useSetAttendance } from "./hrHooks.ts";
import { HrFrame } from "./HrApplicantsScreen.tsx";
import { useHrCapability } from "./HrShared.tsx";
import styles from "./hr.module.css";

type Period = "4w" | "12w" | "26w";
type KindFilter = "all" | meeting.RegularMeetingKind;
type Cell = "present" | "excused" | "absent";

const PERIOD_DAYS: Record<Period, number> = { "4w": 28, "12w": 84, "26w": 182 };
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

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

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function rateTone(rate: number | null): "success" | "warning" | "danger" | "neutral" {
  if (rate === null) return "neutral";
  if (rate >= 0.8) return "success";
  return rate >= 0.5 ? "warning" : "danger";
}

const CELL_LABEL: Record<Cell, string> = { present: "出席", excused: "欠席連絡", absent: "欠席" };
const CELL_TONE: Record<Cell, "success" | "info" | "neutral"> = { present: "success", excused: "info", absent: "neutral" };

export function HrAttendanceScreen(): JSX.Element {
  const [period, setPeriod] = useState<Period>("12w");
  const [kind, setKind] = useState<KindFilter>("all");
  const range = useMemo(() => periodRange(period), [period]);
  const report = useHrAttendance(range);
  const setAttendance = useSetAttendance(range);
  const { canWrite } = useHrCapability();
  const [selected, setSelected] = useState<Record<string, string>>({});

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
  } else if (report.data.meetings.length === 0) {
    body = (
      <EmptyState
        testId="fe2-hr-att-empty"
        icon="calendar"
        title="出席を取っている定例はありません"
        description="カレンダー > ミーティング で定例を作成・編集し、「出席を取る」をオンにすると、Dub から参加した人がここに記録されます。"
      />
    );
  } else {
    const data = report.data;
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
            const cellOf = (userId: string): Cell => {
              const r = occ?.records.find((x) => x.userId === userId);
              return r ? r.status : "absent";
            };
            const presentCount = occ ? m.expectedUserIds.filter((u) => cellOf(u) === "present").length : 0;
            const guests = occ ? occ.records.filter((r) => !m.expectedUserIds.includes(r.userId)) : [];
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
                {m.occurrences.length === 0 || !occ ? (
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
                    <ul className={styles.attList}>
                      {m.expectedUserIds.map((userId) => {
                        const cell = cellOf(userId);
                        const rec = occ.records.find((x) => x.userId === userId);
                        return (
                          <li key={userId} className={styles.attRow} data-testid={`fe2-hr-att-${m.id}-${userId}`}>
                            <span className={styles.attName}>
                              {nameOf.get(userId) ?? userId}
                              {rec?.source === "join" ? <span className={styles.note}>Dub から参加</span> : null}
                            </span>
                            {canWrite ? (
                              <div className={styles.attSelect}>
                                <Select<Cell>
                                  id={`att-${m.id}-${occ.date}-${userId}`}
                                  testId={`fe2-hr-att-set-${m.id}-${userId}`}
                                  value={cell}
                                  onChange={(v) =>
                                    setAttendance.mutate({ meetingId: m.id, date: occ.date, userId, status: v === "absent" ? null : v })
                                  }
                                  options={(["present", "excused", "absent"] as const).map((c) => ({ value: c, label: CELL_LABEL[c] }))}
                                />
                              </div>
                            ) : (
                              <Badge tone={CELL_TONE[cell]}>{CELL_LABEL[cell]}</Badge>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {guests.length > 0 ? (
                      <span className={styles.note}>
                        対象外の参加: {guests.map((g) => nameOf.get(g.userId) ?? g.userId).join("、")}
                      </span>
                    ) : null}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <HrFrame active="attendance">
      <>
        <span className={styles.note}>
          カレンダー › ミーティング で「出席を取る」にした定例が対象です。メンバーが Dub（ダッシュボードの「定例に参加」）から Meet
          に入ると、開始30分前〜終了までの参加が自動で出席になります。Meet のリンクを直接開いた人は記録されないので、ここで直せます。
        </span>
        {toolbar}
        {body}
      </>
    </HrFrame>
  );
}
