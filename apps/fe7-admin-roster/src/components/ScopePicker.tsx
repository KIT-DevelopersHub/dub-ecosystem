import { Select, FormField, type SelectOption } from "@dub/ui";
import { usePermissions } from "../hooks/usePermissions";
import { eventScopeAvailable, type ScopeSelection } from "../lib/scope";

const checkboxRow: React.CSSProperties = { display: "flex", gap: "var(--dub-space-4)", alignItems: "center", margin: "8px 0" };

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
  const eventOptions: SelectOption[] = events.map((ev) => ({ value: ev.id, label: ev.name }));

  return (
    <div data-testid="fe7-scope-picker">
      <div style={checkboxRow}>
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
        <FormField label="対象イベント" htmlFor="fe7-scope-event-select">
          <Select
            id="fe7-scope-event-select"
            value={value.eventId ?? ""}
            options={eventOptions}
            onChange={(v) => onChange({ kind: "event", eventId: v || null })}
            testId="fe7-scope-event-select"
          />
        </FormField>
      ) : null}
    </div>
  );
}
