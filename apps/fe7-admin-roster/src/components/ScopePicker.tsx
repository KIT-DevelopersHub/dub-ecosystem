import { Select, uiStyles as s } from "../ui/primitives";
import { usePermissions } from "../hooks/usePermissions";
import { eventScopeAvailable, type ScopeSelection } from "../lib/scope";

// P0: org-wide or event scope. Event candidates require event:read; without it the
// picker degrades to org-wide only (design §6 FORBIDDEN degrade).
export function ScopePicker({
  value,
  events,
  onChange,
}: {
  value: ScopeSelection;
  events: { id: string; name: string }[];
  onChange: (next: ScopeSelection) => void;
}) {
  const { can } = usePermissions();
  const eventAllowed = eventScopeAvailable(can("event:read") ? ["event:read"] : []);

  return (
    <div data-testid="fe7-scope-picker">
      <div className={s.checkboxRow}>
        <label>
          <input
            type="radio"
            name="scope"
            checked={value.kind === "org"}
            onChange={() => onChange({ kind: "org", eventId: null })}
            data-testid="fe7-scope-org"
          />{" "}
          組織全体
        </label>
        <label>
          <input
            type="radio"
            name="scope"
            checked={value.kind === "event"}
            disabled={!eventAllowed}
            onChange={() => onChange({ kind: "event", eventId: events[0]?.id ?? null })}
            data-testid="fe7-scope-event"
          />{" "}
          イベント単位{!eventAllowed ? "（event:read が必要）" : ""}
        </label>
      </div>
      {value.kind === "event" && eventAllowed ? (
        <Select
          label="対象イベント"
          value={value.eventId ?? ""}
          onChange={(e) => onChange({ kind: "event", eventId: e.target.value || null })}
          testId="fe7-scope-event-select"
        >
          {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
        </Select>
      ) : null}
    </div>
  );
}
