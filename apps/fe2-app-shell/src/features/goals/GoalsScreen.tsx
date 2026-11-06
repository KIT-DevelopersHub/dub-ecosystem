// 目標管理: 月を選び、チームごとの目標・KPI・進捗率を一覧する。実績はサーバが各アプリから数えた値。
import { useState } from "react";
import { Badge, Button, EmptyState, ErrorState, IconButton, PageHeader, SkeletonCard, Stack } from "@dub/ui";
import { goal } from "@dub/types";
import { useAppCapability } from "../../auth/AuthProvider.tsx";
import { useGoals, useGoalSaving } from "./goalsHooks.ts";
import { GoalDrawer } from "./GoalDrawer.tsx";
import styles from "./goals.module.css";

/** 棒は 100% で頭打ち。数字は超過もそのまま出す。pace = 月の経過の目印 (%)。 */
function Meter({ percent, label, pace }: { percent: number | null; label: string; pace?: number }): JSX.Element {
  const value = Math.min(percent ?? 0, 100);
  return (
    <div className={styles.meter} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <div className={styles.meterFill} style={{ width: `${value}%` }} />
      {pace !== undefined && <div className={styles.meterPace} style={{ left: `${pace}%` }} title={`月の経過 ${pace}%`} />}
    </div>
  );
}

function KpiRow({ kpi, saving }: { kpi: goal.KpiProgress; saving: boolean }): JSX.Element {
  const metric = goal.metricOf(kpi.metric);
  const auto = kpi.metric !== "manual";
  const target = goal.formatValue(kpi.target, kpi.metric);
  const value =
    kpi.actual !== null ? `${goal.formatValue(kpi.actual, kpi.metric)} / ${target}`
    : saving ? "集計中…"
    : kpi.status === "unavailable" ? "集計できませんでした"
    : `対象なし / ${target}`;
  return (
    <li className={styles.kpi} data-testid="fe2-goals-kpi">
      <div className={styles.kpiHead}>
        <span className={styles.kpiName}>{kpi.name}</span>
        <span className={styles.kpiPercent}>{kpi.percent === null ? "—" : `${kpi.percent}%`}</span>
      </div>
      <Meter percent={kpi.percent} label={kpi.name} />
      <div className={styles.kpiFoot}>
        <span>{value}</span>
        <span>{auto ? `${metric.source}から自動集計${metric.scope === "org" ? "（全体）" : ""}${kpi.linked ? "・目標は目標タブと連動" : ""}` : "手入力"}</span>
      </div>
    </li>
  );
}

function TeamCard({ team, goal: g, month, pace, canEdit, onEdit }: {
  team: goal.GoalTeam;
  goal: goal.TeamGoal | undefined;
  month: string;
  pace: number | undefined;
  canEdit: boolean;
  onEdit: () => void;
}): JSX.Element {
  const saving = useGoalSaving(month, team.id);
  return (
    <section className={styles.card} data-testid={`fe2-goals-team-${team.id}`} aria-label={team.name}>
      <header className={styles.cardHead}>
        <span className={styles.dot} style={team.color ? { background: team.color } : undefined} aria-hidden />
        <h2 className={styles.teamName}>{team.name}</h2>
        {canEdit && g && <IconButton name="edit" size="sm" aria-label={`${team.name}の目標を編集`} onClick={onEdit} testId={`fe2-goals-edit-${team.id}`} />}
      </header>
      {g ? (
        <>
          <p className={styles.title}>{g.title}</p>
          <div className={styles.total}>
            <span className={styles.totalPercent} data-testid={`fe2-goals-percent-${team.id}`}>{g.percent === null ? "—" : `${g.percent}%`}</span>
            {goal.isAchieved(g) && <Badge tone="success">達成</Badge>}
          </div>
          <Meter percent={g.percent} label={`${team.name}の進捗`} {...(pace === undefined ? {} : { pace })} />
          {g.kpis.length === 0 ? <p className={styles.note}>KPI がまだありません</p> : (
            <ul className={styles.kpis}>{g.kpis.map((k, i) => <KpiRow key={i} kpi={k} saving={saving} />)}</ul>
          )}
        </>
      ) : (
        <div className={styles.unset}>
          <p className={styles.note}>この月の目標は未設定です</p>
          {canEdit && <Button variant="secondary" size="sm" onClick={onEdit} testId={`fe2-goals-set-${team.id}`}>目標を設定</Button>}
        </div>
      )}
    </section>
  );
}

export function GoalsScreen(): JSX.Element {
  const [month, setMonth] = useState(() => goal.currentMonth());
  const [editing, setEditing] = useState<goal.GoalTeam | null>(null);
  const { canEdit } = useAppCapability("goals");
  const list = useGoals(month);

  const days = goal.daysInMonth(month);
  const elapsed = goal.elapsedDays(month);
  const pace = elapsed > 0 && elapsed < days ? Math.round((elapsed / days) * 100) : undefined;
  const goals = list.data?.goals ?? [];
  const goalOf = (teamId: string) => goals.find((g) => g.teamId === teamId);

  return (
    <div className={styles.page}>
      <Stack gap={6} testId="fe2-goals-screen">
        <PageHeader testId="fe2-goals-header" title="目標管理" description="チームごとの月間目標と KPI。実績は Dub の各アプリから自動で集計します。" />
        <div className={styles.monthBar}>
          <span className={styles.flip}>
            <IconButton name="chevron-right" aria-label="前の月" onClick={() => setMonth((m) => goal.shiftMonth(m, -1))} testId="fe2-goals-prev" />
          </span>
          <span className={styles.month} data-testid="fe2-goals-month">{goal.monthLabel(month)}</span>
          <IconButton name="chevron-right" aria-label="次の月" onClick={() => setMonth((m) => goal.shiftMonth(m, 1))} testId="fe2-goals-next" />
          <span className={styles.note}>経過 {elapsed} / {days} 日</span>
          {month !== goal.currentMonth() && <Button variant="ghost" size="sm" onClick={() => setMonth(goal.currentMonth())}>今月へ</Button>}
        </div>
        {list.isPending ? (
          <div className={styles.grid} data-testid="fe2-goals-skeleton">
            {[0, 1, 2].map((i) => <SkeletonCard key={i} lines={4} />)}
          </div>
        ) : list.isError ? (
          <ErrorState testId="fe2-goals-error" error={{ code: "INTERNAL", message: "目標を読み込めませんでした。" }} onRetry={() => void list.refetch()} />
        ) : list.data.teams.length === 0 ? (
          <EmptyState title="チームがありません" description="運営メンバーでチームを作ると、ここに表示されます。" />
        ) : (
          <div className={styles.grid}>
            {list.data.teams.map((t) => (
              <TeamCard key={t.id} team={t} goal={goalOf(t.id)} month={month} pace={pace} canEdit={canEdit} onEdit={() => setEditing(t)} />
            ))}
          </div>
        )}
      </Stack>
      {editing && <GoalDrawer key={`${editing.id}-${month}`} team={editing} month={month} goal={goalOf(editing.id)} linkedTargets={list.data?.linkedTargets ?? {}} onClose={() => setEditing(null)} />}
    </div>
  );
}
