// The event a new 運営メンバー goes into (参加届の反映・採用・名簿の追加), and the event catalog
// for its name. Defaults to the header's current event; "" = どのイベントにも入れない.
// Outside <AuthProvider> (isolated feature tests) the catalog is empty and nothing is shown.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Select } from "@dub/ui";
import type { event } from "@dub/types";
import { useCurrentEventId } from "@dub/fe3-event-action";
import { useOptionalApi } from "../auth/AuthProvider.tsx";
import { queryKeys } from "./queryKeys.tsx";

export function useEventCatalog(): event.EventSummary[] {
  const api = useOptionalApi();
  const { data } = useQuery({
    queryKey: queryKeys.eventCatalog,
    queryFn: async () =>
      (await api!.request<event.ListEventsResponse>({ method: "GET", path: "/api/v1/events", query: { limit: 100 } })).items,
    enabled: api !== null,
    staleTime: 60_000,
  });
  return data ?? [];
}

/** Title of an event from the catalog (null while unknown). */
export function useEventTitle(eventId: string | null): string | null {
  const events = useEventCatalog();
  return (eventId && events.find((e) => e.id === eventId)?.title) || null;
}

/** [eventId | null, set] — starts at the header's current event. */
export function useEventTarget(): [string | null, (id: string | null) => void] {
  const current = useCurrentEventId();
  const [target, setTarget] = useState<string | null>(current);
  useEffect(() => setTarget(current), [current]);
  return [target, setTarget];
}

/** 「どのイベントの運営メンバーに入れるか」. Hidden until the catalog is known. */
export function EventTargetSelect({
  id,
  value,
  onChange,
  testId = "event-target-select",
}: {
  id: string;
  value: string | null;
  onChange: (id: string | null) => void;
  testId?: string;
}): JSX.Element | null {
  const events = useEventCatalog();
  if (events.length === 0) return null;
  const options = [
    { value: "", label: "どのイベントにも入れない" },
    ...events.map((e) => ({ value: e.id, label: e.title })),
  ];
  return (
    <label htmlFor={id} style={{ display: "grid", gap: "var(--dub-space-1)" }}>
      <span style={{ fontSize: "var(--dub-font-size-sm)", color: "var(--dub-color-text-muted)" }}>
        運営メンバーに入れるイベント
      </span>
      <Select id={id} value={value ?? ""} onChange={(v) => onChange(v === "" ? null : v)} options={options} testId={testId} />
    </label>
  );
}
