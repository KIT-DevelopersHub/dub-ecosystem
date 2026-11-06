// 目標の編集ドロワー。目標 1 行 + KPI (名前・集計元・目標値・手入力なら実績) を 1 回で保存する。
import { useState } from "react";
import { Button, ConfirmDialog, Drawer, Form, FormField, IconButton, Select, Stack, TextField } from "@dub/ui";
import { goal } from "@dub/types";
import { ApiError } from "../../lib/api-client.tsx";
import { useRemoveGoal, useSaveGoal } from "./goalsHooks.ts";
import styles from "./goals.module.css";

interface Draft {
  name: string;
  metric: goal.GoalMetric;
  target: string;
  manualActual: string;
}

const METRIC_OPTIONS = goal.GOAL_METRICS.map((m) => ({ value: m.key, label: m.key === "manual" ? m.label : `${m.source}: ${m.label}` }));
const defaultTarget = (metric: goal.GoalMetric): string => (metric === "tasks_done_rate" ? "100" : "");
const newDraft = (): Draft => ({ name: goal.metricOf("tasks_done").label, metric: "tasks_done", target: "", manualActual: "0" });
const toDraft = (k: goal.Kpi): Draft => ({ name: k.name, metric: k.metric, target: String(k.target), manualActual: String(k.manualActual) });

const inRange = (v: string, min: number): boolean => {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n >= min && n <= goal.KPI_VALUE_MAX;
};
const kpiValid = (d: Draft): boolean =>
  d.name.trim().length > 0 && d.name.trim().length <= goal.KPI_NAME_MAX && inRange(d.target, Number.MIN_VALUE) && (d.metric !== "manual" || inRange(d.manualActual, 0));

export function GoalDrawer({ team, month, goal: current, onClose }: {
  team: goal.GoalTeam;
  month: string;
  goal: goal.TeamGoal | undefined;
  onClose: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(current?.title ?? "");
  const [drafts, setDrafts] = useState<Draft[]>(() => (current ? current.kpis.map(toDraft) : [newDraft()]));
  // 下書きと同じ時点の version。編集中の再取得で進めると、他の人の更新を黙って上書きする。
  const [expectedVersion] = useState(current?.version ?? 0);
  const [confirming, setConfirming] = useState(false);
  const save = useSaveGoal(month, team.id);
  const remove = useRemoveGoal(month, team.id);

  const patch = (i: number, next: Partial<Draft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...next } : d)));
  const changeMetric = (i: number, d: Draft, metric: goal.GoalMetric) => {
    const autoNamed = d.name.trim() === "" || d.name === goal.metricOf(d.metric).label;
    patch(i, { metric, target: defaultTarget(metric) || d.target, ...(autoNamed ? { name: goal.metricOf(metric).label } : {}) });
  };

  const valid = title.trim().length > 0 && title.trim().length <= goal.GOAL_TITLE_MAX && drafts.every(kpiValid);
  const submit = () => {
    if (!valid) return;
    save.mutate({
      title: title.trim(),
      expectedVersion,
      kpis: drafts.map((d) => ({
        name: d.name.trim(),
        metric: d.metric,
        target: Number(d.target),
        manualActual: d.metric === "manual" ? Number(d.manualActual) : 0,
      })),
    }, {
      onSuccess: onClose,
      // 失敗しても入力は残す。ただし競合は同じ版で送り直せないので閉じて最新を見てもらう。
      onError: (err) => {
        if (ApiError.isApiError(err) && err.status === 409) onClose();
      },
    });
  };

  return (
    <Drawer testId="fe2-goals-drawer" open onClose={confirming ? () => undefined : onClose} title={`${team.name}の目標（${goal.monthLabel(month)}）`}>
      <Form onSubmit={submit}>
        <Stack gap={5}>
          <FormField label="目標" htmlFor="goal-title" required>
            <TextField id="goal-title" value={title} onChange={setTitle} placeholder="例: 協賛を 3 社決める" testId="fe2-goals-title" />
          </FormField>
          {drafts.map((d, i) => {
            const unit = goal.metricOf(d.metric).unit;
            return (
              <fieldset key={i} className={styles.kpiForm} data-testid={`fe2-goals-kpi-form-${i}`}>
                <legend className={styles.kpiLegend}>KPI {i + 1}</legend>
                <div className={styles.kpiRemove}>
                  <IconButton name="trash" size="sm" aria-label={`KPI ${i + 1} を削除`} onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))} testId={`fe2-goals-kpi-remove-${i}`} />
                </div>
                <Stack gap={4}>
                  <FormField label="何で測るか" htmlFor={`kpi-metric-${i}`} help={goal.metricOf(d.metric).definition}>
                    <Select id={`kpi-metric-${i}`} value={d.metric} options={METRIC_OPTIONS} onChange={(m) => changeMetric(i, d, m)} testId={`fe2-goals-kpi-metric-${i}`} />
                  </FormField>
                  <FormField label="KPI の名前" htmlFor={`kpi-name-${i}`} required>
                    <TextField id={`kpi-name-${i}`} value={d.name} onChange={(v) => patch(i, { name: v })} testId={`fe2-goals-kpi-name-${i}`} />
                  </FormField>
                  <div className={styles.kpiNumbers}>
                    <FormField label={unit ? `目標値（${unit}）` : "目標値"} htmlFor={`kpi-target-${i}`} required>
                      <TextField id={`kpi-target-${i}`} type="number" value={d.target} onChange={(v) => patch(i, { target: v })} testId={`fe2-goals-kpi-target-${i}`} />
                    </FormField>
                    {d.metric === "manual" && (
                      <FormField label="今の実績" htmlFor={`kpi-actual-${i}`} required>
                        <TextField id={`kpi-actual-${i}`} type="number" value={d.manualActual} onChange={(v) => patch(i, { manualActual: v })} testId={`fe2-goals-kpi-actual-${i}`} />
                      </FormField>
                    )}
                  </div>
                </Stack>
              </fieldset>
            );
          })}
          <div>
            <Button variant="secondary" size="sm" disabled={drafts.length >= goal.KPI_MAX} onClick={() => setDrafts((ds) => [...ds, newDraft()])} testId="fe2-goals-kpi-add">KPI を追加</Button>
          </div>
          <div className={styles.actions}>
            {current && <Button variant="ghost" onClick={() => setConfirming(true)} testId="fe2-goals-delete">この目標を削除</Button>}
            <Button variant="secondary" onClick={onClose}>キャンセル</Button>
            <Button type="submit" disabled={!valid} loading={save.isPending} testId="fe2-goals-save">保存</Button>
          </div>
        </Stack>
      </Form>
      <ConfirmDialog
        open={confirming}
        title="目標を削除しますか"
        message={`${team.name}の${goal.monthLabel(month)}の目標と KPI を削除します。元に戻せません。`}
        confirmLabel="削除"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          remove.mutate();
          setConfirming(false);
          onClose();
        }}
      />
    </Drawer>
  );
}
