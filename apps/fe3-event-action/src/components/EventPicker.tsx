import type { common, event } from "@dub/types";
import { useEventsQuery } from "../hooks/useEventQueries";
import styles from "./components.module.css";

export interface EventPickerProps {
  value: common.EventId | null;
  onChange: (id: common.EventId) => void;
  phaseFilter?: event.EventPhase[];
  includeArchived?: boolean;
  testId?: string;
}

/** Reusable event selector consumed by other units (FE4/FE5/FE6). */
export function EventPicker({ value, onChange, phaseFilter, includeArchived, testId }: EventPickerProps) {
  const query = useEventsQuery({ includeArchived: includeArchived ?? false, limit: 200 });
  const all = query.data?.items ?? [];
  const items = phaseFilter && phaseFilter.length > 0 ? all.filter((e) => phaseFilter.includes(e.phase)) : all;

  return (
    <select
      className={styles.select}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId ?? "fe3-event-picker"}
    >
      <option value="" disabled>
        イベントを選択
      </option>
      {items.map((e) => (
        <option key={e.id} value={e.id}>
          {e.title}
        </option>
      ))}
    </select>
  );
}
