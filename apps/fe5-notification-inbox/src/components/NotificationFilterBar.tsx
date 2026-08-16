// NotificationFilterBar — type-group tabs + a controls row (search, sort, unread-only).
// Emits filter changes and search-query changes; URL sync is handled by the page
// (FE5 §2-2, test 3). Layout/spacing come from @dub/tokens (no hard-coded gaps) so the
// "Unread only" control is no longer crowding the tabs.

import type { ReactNode } from "react";
import { SearchInput, SegmentedControl, Switch, Tabs, type TabItem } from "@dub/ui";
import type { InboxFilter, InboxSort } from "../lib/inbox-filter";
import { NOTIFICATION_GROUP_PREFIXES } from "../lib/type-dictionary";
import styles from "./NotificationFilterBar.module.css";

// TabItem.id carries the filter value ("" = All, else the type-group prefix).
const TYPE_OPTIONS: TabItem[] = [
  { id: "", label: "All" },
  ...NOTIFICATION_GROUP_PREFIXES.map((g) => ({ id: g.prefix, label: g.label })),
];

const SORT_OPTIONS: { value: InboxSort; label: string }[] = [
  { value: "newest", label: "新しい順" },
  { value: "oldest", label: "古い順" },
];

export interface NotificationFilterBarProps {
  filter: InboxFilter;
  onChange: (next: InboxFilter) => void;
  /** Search query (client-side title/body filter). */
  query: string;
  onQueryChange: (next: string) => void;
}

export function NotificationFilterBar(props: NotificationFilterBarProps): ReactNode {
  const { filter, onChange, query, onQueryChange } = props;
  return (
    <div className={styles.bar} data-testid="fe5-inbox-filterbar">
      <Tabs
        items={TYPE_OPTIONS}
        activeId={filter.type}
        onChange={(type) => onChange({ ...filter, type })}
        testId="fe5-inbox-typefilter"
      />
      <div className={styles.controls}>
        <div className={styles.search}>
          <SearchInput
            value={query}
            onChange={onQueryChange}
            placeholder="通知を検索"
            size="sm"
            debounceMs={200}
            aria-label="通知を検索"
            testId="fe5-inbox-search"
          />
        </div>
        <SegmentedControl<InboxSort>
          options={SORT_OPTIONS}
          value={filter.sort ?? "newest"}
          onChange={(sort) => onChange({ ...filter, sort })}
          size="sm"
          aria-label="並び順"
          testId="fe5-inbox-sort"
        />
        <Switch
          id="fe5-inbox-unreadonly"
          checked={filter.unreadOnly}
          onChange={(unreadOnly) => onChange({ ...filter, unreadOnly })}
          label="Unread only"
          testId="fe5-inbox-unreadtoggle"
        />
      </div>
    </div>
  );
}
