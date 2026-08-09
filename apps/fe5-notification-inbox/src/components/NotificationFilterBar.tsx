// NotificationFilterBar — unread-only toggle + type-group filter (prefix match).
// Emits filter changes; URL sync is handled by the page (FE5 §2-2, test 3).

import type { ReactNode } from "react";
import { Switch, Tabs, type TabOption } from "../contracts/fe1";
import type { InboxFilter } from "../lib/inbox-filter";
import { NOTIFICATION_GROUP_PREFIXES } from "../lib/type-dictionary";

const TYPE_OPTIONS: TabOption[] = [
  { value: "", label: "All" },
  ...NOTIFICATION_GROUP_PREFIXES.map((g) => ({ value: g.prefix, label: g.label })),
];

export interface NotificationFilterBarProps {
  filter: InboxFilter;
  onChange: (next: InboxFilter) => void;
}

export function NotificationFilterBar(props: NotificationFilterBarProps): ReactNode {
  const { filter, onChange } = props;
  return (
    <div data-testid="fe5-inbox-filterbar">
      <Tabs
        options={TYPE_OPTIONS}
        value={filter.type}
        onChange={(type) => onChange({ ...filter, type })}
        aria-label="Filter by type"
        testId="fe5-inbox-typefilter"
      />
      <Switch
        checked={filter.unreadOnly}
        onChange={(unreadOnly) => onChange({ ...filter, unreadOnly })}
        label="Unread only"
        testId="fe5-inbox-unreadtoggle"
      />
    </div>
  );
}
