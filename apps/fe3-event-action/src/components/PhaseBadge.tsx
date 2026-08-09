import type { event } from "@dub/types";
import styles from "./components.module.css";

const PHASE_LABEL: Record<event.EventPhase, string> = {
  planning: "計画",
  preparing: "準備",
  open: "受付",
  live: "開催中",
  wrapup: "まとめ",
  closed: "終了",
};

export function PhaseBadge({ phase, testId }: { phase: event.EventPhase; testId?: string }) {
  return (
    <span className={styles.badge} data-phase={phase} data-testid={testId}>
      {PHASE_LABEL[phase]}
    </span>
  );
}

export function phaseLabel(phase: event.EventPhase): string {
  return PHASE_LABEL[phase];
}
