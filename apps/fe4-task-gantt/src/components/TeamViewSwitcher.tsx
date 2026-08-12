import type { common, team } from "@dub/types";
import styles from "../styles/app.module.css";

export interface TeamViewSwitcherProps {
  teams: readonly team.Team[];
  /** undefined = 全体表示 (all teams). */
  value: common.TeamId | undefined;
  onChange: (teamId: common.TeamId | undefined) => void;
  disabled?: boolean;
}

/**
 * Timeline view switch: 全体表示 (all) or a single team. Sits above the gantt and
 * feeds the shared filter (ANDed with the status filter), so switching narrows
 * the axis/bars/dependencies to the chosen team.
 */
export function TeamViewSwitcher({ teams, value, onChange, disabled }: TeamViewSwitcherProps) {
  return (
    <div className={styles.teamSwitch} role="tablist" aria-label="表示切替" data-testid="fe4-team-switch">
      <span className={styles.teamSwitchLead}>表示</span>
      <button
        type="button"
        role="tab"
        aria-selected={value === undefined}
        disabled={disabled}
        className={`${styles.teamChip} ${value === undefined ? styles.teamChipOn : ""}`}
        onClick={() => onChange(undefined)}
        data-testid="fe4-team-all"
      >
        全体表示
      </button>
      {teams.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          disabled={disabled}
          className={`${styles.teamChip} ${value === t.id ? styles.teamChipOn : ""}`}
          onClick={() => onChange(t.id)}
          data-testid={`fe4-team-${t.id}`}
        >
          <span className={styles.teamDot} style={{ background: t.color ?? "var(--dub-color-gray-400)" }} aria-hidden />
          {t.name}
        </button>
      ))}
    </div>
  );
}
