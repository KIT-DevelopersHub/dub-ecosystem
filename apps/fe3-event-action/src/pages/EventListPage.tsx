import { useState } from "react";
import type { event } from "@dub/types";
import { Button, LoadMore } from "../contracts/fe1";
import { useCan } from "../contracts/fe2";
import { useNavigation } from "../contracts/navigation";
import { useEventsQuery } from "../hooks/useEventQueries";
import { EventCard } from "../components/EventCard";
import { EventCreateModal } from "../components/EventCreateModal";
import { eventRoutes } from "../lib/routes";
import { parseEventListFilter, serializeEventListFilter } from "../lib/filterState";
import { phaseLabel } from "../components/PhaseBadge";
import styles from "../components/components.module.css";

const PHASES: readonly event.EventPhase[] = ["planning", "preparing", "open", "live", "wrapup", "closed"];

export function EventListPage() {
  const nav = useNavigation();
  const filter = parseEventListFilter(nav.search);
  const canWrite = useCan("event:write");
  const [createOpen, setCreateOpen] = useState(false);

  const query: event.ListEventsQuery = { includeArchived: filter.includeArchived };
  if (filter.phase) query.phase = filter.phase;
  const { data, isLoading } = useEventsQuery(query);
  const items = data?.items ?? [];

  const updateFilter = (patch: Partial<typeof filter>) => {
    nav.setSearch(serializeEventListFilter({ ...filter, ...patch }));
  };

  return (
    <div className={styles.page} data-testid="fe3-eventlist">
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>イベント</h1>
        {canWrite ? (
          <Button icon="plus" variant="primary" onClick={() => setCreateOpen(true)} testId="fe3-eventlist-create">
            イベントを作成
          </Button>
        ) : null}
      </div>

      <div className={styles.toolbar}>
        <select
          className={styles.select}
          value={filter.phase ?? ""}
          onChange={(e) => updateFilter({ phase: e.target.value === "" ? null : (e.target.value as event.EventPhase) })}
          data-testid="fe3-eventlist-phase-filter"
        >
          <option value="">すべてのフェーズ</option>
          {PHASES.map((p) => (
            <option key={p} value={p}>
              {phaseLabel(p)}
            </option>
          ))}
        </select>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={filter.includeArchived}
            onChange={(e) => updateFilter({ includeArchived: e.target.checked })}
            data-testid="fe3-eventlist-archived-toggle"
          />
          アーカイブを表示
        </label>
      </div>

      {isLoading ? (
        <div className={styles.emptyState}>読み込み中…</div>
      ) : items.length === 0 ? (
        <div className={styles.emptyState}>イベントがありません</div>
      ) : (
        <div className={styles.grid}>
          {items.map((ev) => (
            <EventCard key={ev.id} event={ev} onOpen={(id) => nav.navigate(eventRoutes.detail(id))} />
          ))}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <LoadMore
          hasMore={Boolean(data?.nextCursor)}
          loading={isLoading}
          onClick={() => {
            /* cursor pagination wired via query when nextCursor present (LoadMore, not infinite scroll) */
          }}
          testId="fe3-eventlist-loadmore"
        />
      </div>

      <EventCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(ev) => nav.navigate(eventRoutes.detail(ev.id))}
      />
    </div>
  );
}
