// NotificationFilterBar — category tabs (All / アプリアップデート / メール / 参加届) + an
// unread-only toggle. Emits filter changes; URL sync is handled by the page (FE5 §2-2, test 3).
// The tabs derive from the single-source category taxonomy in type-dictionary.

import type { ReactNode } from "react";
import { Stack, Switch, Tabs, type TabItem } from "@dub/ui";
import type { InboxFilter } from "../lib/inbox-filter";
import { NOTIFICATION_CATEGORY_TABS, type CategoryFilter } from "../lib/type-dictionary";

// TabItem.id carries the CategoryFilter value ("all" | "app_update" | "mail" | "participation").
const CATEGORY_OPTIONS: TabItem[] = NOTIFICATION_CATEGORY_TABS.map((t) => ({
  id: t.id,
  label: t.label,
}));

export interface NotificationFilterBarProps {
  filter: InboxFilter;
  onChange: (next: InboxFilter) => void;
}

export function NotificationFilterBar(props: NotificationFilterBarProps): ReactNode {
  const { filter, onChange } = props;
  return (
    // Stack with a token-based gap so the tab row and the "Unread only" toggle are not
    // cramped together (spacing規約: 隣接する操作要素は最低限の余白を確保する — see docs/FRONTEND_GUIDE.md).
    <Stack gap={3} testId="fe5-inbox-filterbar">
      <Tabs
        items={CATEGORY_OPTIONS}
        activeId={filter.category}
        onChange={(id) => onChange({ ...filter, category: id as CategoryFilter })}
        testId="fe5-inbox-catfilter"
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
