// スポンサー → 目標。月ごとに目標を置き、営業進捗の日付から数えた実績と達成率を見る。
// 上 = 選んだ月の 4 指標 (実績 / 目標・達成率・メーター)、下 = 直近 6 か月の推移。目標の設定は sponsor:write の人だけ。
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, DataTable, ErrorState, FormField, Modal, Skeleton, SkeletonTable, Stack, TextField, type ColumnDef } from "@dub/ui";
import { DialogActions } from "@dub/app-ui";
import { sponsor } from "@dub/types";
import { useAppCapability } from "../../auth/AuthProvider.tsx";
import { useGoals, useLeads, usePutGoal } from "./leadHooks.ts";
import { achievement, currentMonth, formatMetric, METRICS, monthActuals, monthLabel, shiftMonth, undatedLeads, type Actuals } from "./goals.ts";
import { parseAmount } from "./leadImport.ts";
import { useSponsorCapability } from "./SponsorShared.tsx";
import { SponsorFrame } from "./SponsorCardsScreen.tsx";
import styles from "./sponsor.module.css";

const HISTORY_MONTHS = 6;

type FormValues = Record<sponsor.GoalMetric, string>;

function GoalCard({ metric, actual, target }: { metric: (typeof METRICS)[number]; actual: number; target: number | null }): JSX.Element {
  const rate = achievement(actual, target);
  const remaining = target === null ? 0 : target - actual;
  return (
    <div className={styles.goalCard} data-testid={`fe2-sponsor-goal-${metric.key}`}>
      <div className={styles.goalHead}>
        <span className={styles.goalLabel}>{metric.label}</span>
        {target !== null && actual >= target ? <Badge tone="success">達成</Badge> : null}
      </div>
      <div className={styles.goalNumbers}>
        <span className={styles.goalActual} data-testid={`fe2-sponsor-goal-actual-${metric.key}`}>
          {formatMetric(actual, metric.unit)}
        </span>
        {target !== null ? <span className={styles.goalTarget}>/ {formatMetric(target, metric.unit)}</span> : null}
      </div>
      {rate !== null ? (
        <>
          <div
            className={styles.meter}
            role="progressbar"
            aria-label={`${metric.label}の達成率`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(rate, 100)}
          >
            <div className={styles.meterFill} style={{ width: `${Math.min(rate, 100)}%` }} />
          </div>
          <div className={styles.goalFoot}>
            <span className={styles.goalRate} data-testid={`fe2-sponsor-goal-rate-${metric.key}`}>
              {rate}%
            </span>
            <span className={styles.note}>{remaining > 0 ? `あと ${formatMetric(remaining, metric.unit)}` : "目標に到達"}</span>
          </div>
        </>
      ) : (
        <p className={styles.note}>目標は未設定です</p>
      )}
    </div>
  );
}

const isValidTarget = (v: string): boolean => v.trim() === "" || (parseAmount(v) ?? 0) > 0;

function GoalDialog({ month, goal, open, onClose }: { month: string; goal: sponsor.MonthlyGoal | null; open: boolean; onClose: () => void }): JSX.Element {
  const put = usePutGoal();
  const [form, setForm] = useState<FormValues>({ contacted: "", proposed: "", agreed: "", amount: "" });
  useEffect(() => {
    if (open) {
      setForm(Object.fromEntries(METRICS.map((m) => [m.key, goal?.[m.key]?.toString() ?? ""])) as FormValues);
    }
  }, [open, goal]);
  const valid = METRICS.every((m) => isValidTarget(form[m.key]));
  return (
    <Modal testId="fe2-sponsor-goal-dialog" open={open} onClose={onClose} title={`${monthLabel(month)}の目標`} size="md">
      <Stack gap={4}>
        <p className={styles.note}>空欄の指標は目標なしになります。</p>
        <div className={styles.formGrid}>
          {METRICS.map((m) => (
            <FormField
              key={m.key}
              label={`${m.label}（${m.unit}）`}
              htmlFor={`sponsor-goal-${m.key}`}
              help={m.definition}
              error={isValidTarget(form[m.key]) ? undefined : "1 以上の数字で入力してください"}
            >
              <TextField
                id={`sponsor-goal-${m.key}`}
                testId={`fe2-sponsor-goal-field-${m.key}`}
                value={form[m.key]}
                onChange={(v) => setForm({ ...form, [m.key]: v })}
                invalid={!isValidTarget(form[m.key])}
              />
            </FormField>
          ))}
        </div>
        <DialogActions>
          <Button variant="secondary" size="lg" testId="fe2-sponsor-goal-cancel" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            size="lg"
            testId="fe2-sponsor-goal-save"
            disabled={!valid}
            onClick={() => {
              const targets = Object.fromEntries(METRICS.map((m) => [m.key, parseAmount(form[m.key])])) as sponsor.GoalTargets;
              put.mutate({ month, targets, expectedVersion: goal?.version ?? 0 });
              onClose();
            }}
          >
            保存する
          </Button>
        </DialogActions>
      </Stack>
    </Modal>
  );
}

interface HistoryRow {
  month: string;
  selected: boolean;
  actuals: Actuals;
  goal: sponsor.MonthlyGoal | null;
}

function historyCell(row: HistoryRow, metric: (typeof METRICS)[number]): string {
  const actual = formatMetric(row.actuals[metric.key], metric.unit);
  const target = row.goal?.[metric.key] ?? null;
  return target === null ? actual : `${actual}（${achievement(row.actuals[metric.key], target)}%）`;
}

const HISTORY_COLUMNS: ColumnDef<HistoryRow>[] = [
  {
    key: "month",
    header: "月",
    noWrap: true,
    cell: (r) => (
      <span className={styles.leadNext}>
        <span className={styles.rowName} data-testid={`fe2-sponsor-goal-month-${r.month}`}>
          {monthLabel(r.month)}
        </span>
        {r.selected ? <Badge tone="info">表示中</Badge> : null}
      </span>
    ),
  },
  ...METRICS.map((m) => ({ key: m.key, header: m.label, noWrap: true, cell: (r: HistoryRow) => historyCell(r, m) })),
];

export function SponsorGoalsScreen(): JSX.Element {
  const leads = useLeads();
  const goals = useGoals();
  const { canWrite } = useSponsorCapability();
  const { canView: canViewGoalsApp } = useAppCapability("goals");
  const [month, setMonth] = useState(currentMonth);
  const [editing, setEditing] = useState(false);

  const all = useMemo(() => leads.data?.leads ?? [], [leads.data]);
  const goalOf = (m: string) => goals.data?.goals.find((g) => g.month === m) ?? null;
  const goal = goalOf(month);
  const actuals = useMemo(() => monthActuals(all, month), [all, month]);
  const undated = undatedLeads(all);
  const ready = leads.data !== undefined && goals.data !== undefined;

  // 基準は今月で固定 (行を押しても表が動かない)。
  const history: HistoryRow[] = Array.from({ length: HISTORY_MONTHS }, (_, i) => {
    const m = shiftMonth(currentMonth(), -i);
    return { month: m, selected: m === month, actuals: monthActuals(all, m), goal: goalOf(m) };
  });

  let body: JSX.Element;
  if (leads.isError || goals.isError) {
    body = (
      <ErrorState
        testId="fe2-sponsor-goals-error"
        error={{ code: "INTERNAL", message: "目標を読み込めませんでした。" }}
        onRetry={() => {
          void leads.refetch();
          void goals.refetch();
        }}
      />
    );
  } else if (!ready) {
    body = (
      <div className={styles.leadsLoading} data-testid="fe2-sponsor-goals-loading" aria-busy="true" aria-label="目標を読み込み中">
        <div className={styles.goalGrid}>
          {METRICS.map((m) => (
            <Skeleton key={m.key} variant="rect" width="100%" height="9rem" />
          ))}
        </div>
        <SkeletonTable rows={HISTORY_MONTHS} columns={5} />
      </div>
    );
  } else {
    body = (
      <>
        <div className={styles.goalGrid}>
          {METRICS.map((m) => (
            <GoalCard key={m.key} metric={m} actual={actuals[m.key]} target={goal?.[m.key] ?? null} />
          ))}
        </div>
        <Stack gap={3}>
          <h3 className={styles.leadSectionTitle}>直近 {HISTORY_MONTHS} か月の推移</h3>
          <DataTable<HistoryRow>
            testId="fe2-sponsor-goals-history"
            columns={HISTORY_COLUMNS}
            rows={history}
            rowKey={(r) => r.month}
            onRowClick={(r) => setMonth(r.month)}
          />
        </Stack>
        <div className={styles.goalNotes}>
          {canViewGoalsApp ? (
            <p className={styles.note} data-testid="fe2-sponsor-goals-link">
              ここで決めた目標は、<a href="/goals">目標管理</a>のチームの KPI にも反映されます。
            </p>
          ) : null}
          <p className={styles.note}>{METRICS.map((m) => `${m.label} = ${m.definition}`).join("。")}。</p>
          {undated > 0 ? (
            <p className={styles.note} data-testid="fe2-sponsor-goals-undated">
              初回連絡日・提案日・内諾日のいずれかが空の {undated} 社は、その分が月の実績に入っていません（「営業」タブの詳細から日付を入れると数えられます）。
            </p>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <SponsorFrame
      active="goals"
      wide
      actions={
        canWrite && ready ? (
          <Button testId="fe2-sponsor-goal-edit" onClick={() => setEditing(true)}>
            {goal ? "目標を編集" : "目標を設定"}
          </Button>
        ) : undefined
      }
    >
      <>
        <div className={styles.monthNav}>
          <Button variant="secondary" size="sm" testId="fe2-sponsor-goal-prev" onClick={() => setMonth(shiftMonth(month, -1))}>
            前の月
          </Button>
          <span className={styles.monthLabel} data-testid="fe2-sponsor-goal-month" aria-live="polite">
            {monthLabel(month)}
          </span>
          <Button variant="secondary" size="sm" testId="fe2-sponsor-goal-next" onClick={() => setMonth(shiftMonth(month, 1))}>
            次の月
          </Button>
          {month !== currentMonth() ? (
            <Button variant="ghost" size="sm" testId="fe2-sponsor-goal-today" onClick={() => setMonth(currentMonth())}>
              今月に戻る
            </Button>
          ) : null}
        </div>
        {body}
        <GoalDialog month={month} goal={goal} open={editing} onClose={() => setEditing(false)} />
      </>
    </SponsorFrame>
  );
}
