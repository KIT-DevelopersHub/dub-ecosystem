// Under the search box: the filter panel (when opened) and, whenever filters are set, one
// removable chip per filter + すべて解除 — so an active filter is always visible and one
// click away from clearing, even with the panel closed.
import { useMemo } from "react";
import { Tag } from "@dub/ui";
import { useMailStore } from "../useMailStore.tsx";
import { MailFilterBar } from "./MailFilterBar.tsx";
import { describeFilters, filtersActive, knownAddresses, NO_FILTERS, receivingAddresses, withoutFilter, type MailFilters } from "./mailFilters.ts";
import styles from "./MailFilterBar.module.css";

export function MailFilterRegion({ open }: { open: boolean }): JSX.Element | null {
  const { state, dispatch } = useMailStore();
  const { filters, threads, me, listLoading } = state;
  const setFilters = (next: MailFilters): void => dispatch({ type: "SET_FILTERS", filters: next });
  const addresses = useMemo(() => knownAddresses(threads, me), [threads, me]);
  const mailboxes = useMemo(() => receivingAddresses(threads, me.email, filters.mailbox ? [filters.mailbox] : []), [threads, me.email, filters.mailbox]);
  const nameOf = (email: string): string => addresses.find((a) => a.email === email)?.name ?? email;
  const active = filtersActive(filters);
  if (!open && !active) return null;
  return (
    <div className={styles.region} data-testid="fe2-mail-filter-region">
      {open ? <MailFilterBar value={filters} onChange={setFilters} addresses={addresses} mailboxes={mailboxes} loading={listLoading} /> : null}
      {active ? (
        <div className={styles.active} role="group" aria-label="適用中の絞り込み" data-testid="fe2-mail-filter-active">
          <span className={styles.activeLabel}>絞り込み中:</span>
          {describeFilters(filters, nameOf).map((c) => (
            <Tag key={c.key} tone="brand" onRemove={() => setFilters(withoutFilter(filters, c.key))} testId={`fe2-mail-filter-active-${c.key}`}>
              {c.label}
            </Tag>
          ))}
          <button type="button" className={styles.clearAll} onClick={() => setFilters(NO_FILTERS)} data-testid="fe2-mail-filter-active-clear">
            すべて解除
          </button>
        </div>
      ) : null}
    </div>
  );
}
