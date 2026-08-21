// NotificationFilterBar — unread-only toggle + type-group filter (prefix match).
// Emits filter changes; URL sync is handled by the page (FE5 §2-2, test 3).

import type { ReactNode } from "react";
import { Stack, Switch, Tabs, type TabItem } from "@dub/ui";
import type { InboxFilter } from "../lib/inbox-filter";
import { NOTIFICATION_GROUP_PREFIXES } from "../lib/type-dictionary";

// TabItem.id carries the filter value ("" = All, else the type-group prefix).
const TYPE_OPTIONS: TabItem[] = [
  { id: "", label: "All" },
  ...NOTIFICATION_GROUP_PREFIXES.map((g) => ({ id: g.prefix, label: g.label })),
];

export interface NotificationFilterBarProps {
  filter: InboxFilter;
  onChange: (next: InboxFilter) => void;
}

export function NotificationFilterBar(props: NotificationFilterBarProps): ReactNode {
  const { filter, onChange } = props;
  // Breathing room between the type tabs and the unread-only toggle so the
  // switch doesn't crowd the tab row (space-4 = 16px, @dub/tokens).
  return (
    <Stack gap={4} align="start" testId="fe5-inbox-filterbar">
      <Tabs
        items={TYPE_OPTIONS}
        activeId={filter.type}
        onChange={(type) => onChange({ ...filter, type })}
        testId="fe5-inbox-typefilter"
      />
      <Switch
        id="fe5-inbox-unreadonly"
        checked={filter.unreadOnly}
        onChange={(unreadOnly) => onChange({ ...filter, unreadOnly })}
        label="Unread only"
        testId="fe5-inbox-unreadtoggle"
      />
    </Stack>
  );
}
