// NotificationTypeLabel — resolves a NotificationType to its display label +
// icon via the dictionary (longest match; unknown -> raw string, generic icon).

import type { ReactNode } from "react";
import { Icon } from "@dub/ui";
import type { NotificationType } from "../contracts/notification-api";
import { resolveTypeDisplay } from "../lib/type-dictionary";

export function NotificationTypeLabel(props: {
  type: NotificationType;
  showLabel?: boolean;
}): ReactNode {
  const d = resolveTypeDisplay(props.type);
  return (
    <span data-known={d.known} data-group={d.group}>
      <Icon name={d.icon} aria-label={d.label} />
      {props.showLabel !== false ? <span>{d.label}</span> : null}
    </span>
  );
}
