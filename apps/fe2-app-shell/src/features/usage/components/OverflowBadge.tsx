// OverflowBadge — the halt/bill distinction as a @dub/ui Badge with a leading icon.
//   halt → shield / info tone / "上限で自動停止（課金なし）" (Cloudflare free: stops, never bills)
//   bill → alert / danger tone / "上限超で課金発生"
// This is the single most important clarity signal on a card: whether hitting 100%
// costs money or just stops. Reusable/atomic — copy, tone and icon come from
// overflowMeta so the card and the top summary never drift apart.
import { Badge, Icon } from "@dub/ui";
import { overflowMeta } from "../usageStatus.ts";
import type { OverflowBehavior } from "../types.ts";

export interface OverflowBadgeProps {
  behavior: OverflowBehavior;
  testId?: string;
}

export function OverflowBadge({ behavior, testId }: OverflowBadgeProps): JSX.Element {
  const meta = overflowMeta(behavior);
  return (
    <Badge tone={meta.tone} testId={testId ?? `fe2-usage-overflow-${behavior}`}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
        <Icon name={meta.icon} size="sm" />
        {meta.label}
      </span>
    </Badge>
  );
}
