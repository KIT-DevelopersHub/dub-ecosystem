// EventAppHeader — the event app's own header bar carrying the global current-event
// switcher. Selecting an event here drives the persisted currentEvent store, which
// every event-scoped screen reads. (When the FE2 shell grows a global switcher it
// can drive the same store; until then this is the app's header.)
import { Icon } from "@dub/ui";
import { EventPicker } from "./EventPicker";
import { useCurrentEventId, useSetCurrentEventId } from "../lib/currentEvent";
import styles from "./components.module.css";

export function EventAppHeader() {
  const eventId = useCurrentEventId();
  const setEventId = useSetCurrentEventId();
  return (
    <header className={styles.appHeader} data-testid="fe3-app-header">
      <div className={styles.appHeaderLeft}>
        <Icon name="calendar" />
        <span className={styles.appHeaderTitle}>イベント</span>
      </div>
      <div className={styles.appHeaderPicker}>
        <span className={styles.appHeaderPickerLabel}>表示中:</span>
        <EventPicker value={eventId} onChange={setEventId} testId="fe3-header-event-picker" />
      </div>
    </header>
  );
}
