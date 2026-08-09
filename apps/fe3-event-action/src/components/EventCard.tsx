import type { event } from "@dub/types";
import { Icon } from "../contracts/fe1";
import { PhaseBadge } from "./PhaseBadge";
import styles from "./components.module.css";

function fmtDate(iso: string | null): string {
  if (!iso) return "日程未定";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "日程未定" : d.toLocaleDateString("ja-JP");
}

export function EventCard({ event: ev, onOpen }: { event: event.EventSummary; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className={styles.card}
      onClick={() => onOpen(ev.id)}
      data-testid={`fe3-eventlist-card-${ev.id}`}
    >
      <div className={styles.cardTitle}>{ev.title}</div>
      <div className={styles.cardMeta}>
        <PhaseBadge phase={ev.phase} />
        <span>
          <Icon name="calendar" /> {fmtDate(ev.startsAt)}
        </span>
      </div>
    </button>
  );
}
