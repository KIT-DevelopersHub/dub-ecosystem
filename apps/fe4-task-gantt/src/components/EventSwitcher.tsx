// Header event selector (GCP-style project switcher). A persistent dropdown that
// shows the current event and lets the user switch anytime — replacing the former
// "pick an event every visit" landing screen. Built on the @dub/ui `Menu`
// primitive so it matches every other header dropdown (outside-click / Esc close,
// design-system tokens). View-only: it just reports the chosen id upward.
import { Menu } from "@dub/ui";
import type { common } from "@dub/types";
import styles from "../styles/app.module.css";

export interface EventChoice {
  id: common.EventId;
  title: string;
}

export interface EventSwitcherProps {
  events: readonly EventChoice[];
  value: common.EventId;
  onSelect: (eventId: common.EventId) => void;
  /** true while the event list is still loading (keeps the current title, no items). */
  loading?: boolean;
  testId?: string;
}

export function EventSwitcher({ events, value, onSelect, loading, testId }: EventSwitcherProps): JSX.Element {
  const current = events.find((e) => e.id === value);
  // Fall back to the raw id only until the list resolves, so the control never
  // renders empty on first paint (the event is always known from the route).
  const label = current?.title ?? (loading ? "読み込み中…" : "イベントを選択");

  const items = events.map((e) => ({
    id: e.id,
    label: e.title,
    // A check marks the active event so the current selection is obvious in the list.
    ...(e.id === value ? { icon: "check" as const } : {}),
    onSelect: () => {
      if (e.id !== value) onSelect(e.id);
    },
    testId: testId ? `${testId}-item-${e.id}` : undefined,
  }));

  return (
    <div className={styles.eventSwitcher}>
      <span className={styles.eventSwitcherEyebrow}>イベント</span>
      <Menu
        label={label}
        items={items}
        icon="calendar"
        variant="secondary"
        align="start"
        menuLabel="表示するイベントを選択"
        {...(testId ? { testId } : {})}
      />
    </div>
  );
}
