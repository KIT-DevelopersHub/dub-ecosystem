import { SegmentedControl } from "@dub/ui";
import type { SegmentedOption } from "@dub/ui";
import type { common, team } from "@dub/types";
import styles from "../styles/app.module.css";

export interface TeamViewSwitcherProps {
  teams: readonly team.Team[];
  /** undefined = 全体表示 (all teams). */
  value: common.TeamId | undefined;
  onChange: (teamId: common.TeamId | undefined) => void;
  disabled?: boolean;
}

// Sentinel value for the "全体表示" (all-teams) segment. SegmentedControl values
// must be strings, so we map this sentinel ⇄ `undefined` at the boundary.
const ALL = "__all__";

/**
 * Timeline view switch: 全体表示 (all) or a single team. Sits above the gantt and
 * feeds the shared filter (ANDed with the status filter), so switching narrows
 * the axis/bars/dependencies to the chosen team.
 *
 * A03: built on the shared @dub/ui SegmentedControl so the active highlight
 * glides between teams (reduced-motion drops the glide). Each team keeps its
 * colour dot via a ReactNode label.
 */
export function TeamViewSwitcher({ teams, value, onChange, disabled }: TeamViewSwitcherProps) {
  const options: SegmentedOption<string>[] = [
    { value: ALL, label: "全体表示", testId: "fe4-team-all", ...(disabled ? { disabled: true } : {}) },
    ...teams.map(
      (t): SegmentedOption<string> => ({
        value: t.id,
        testId: `fe4-team-${t.id}`,
        ...(disabled ? { disabled: true } : {}),
        label: (
          <span className={styles.teamChipLabel}>
            <span
              className={styles.teamDot}
              style={{ background: t.color ?? "var(--dub-color-gray-400)" }}
              aria-hidden
            />
            {t.name}
          </span>
        ),
      }),
    ),
  ];

  return (
    <div className={styles.teamSwitch}>
      <span className={styles.teamSwitchLead}>表示</span>
      <SegmentedControl<string>
        aria-label="表示切替"
        testId="fe4-team-switch"
        value={value ?? ALL}
        onChange={(next) => onChange(next === ALL ? undefined : (next as common.TeamId))}
        options={options}
      />
    </div>
  );
}
