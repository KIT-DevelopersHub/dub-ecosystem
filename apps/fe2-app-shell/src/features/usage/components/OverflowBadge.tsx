// OverflowBadge — a @dub/ui Badge stating what happens on quota overflow.
//   halt → "超過すると停止(429)・自動課金なし" (Cloudflare free: stops, never bills)
//   bill → "超過すると課金"
// Reusable/atomic: it only needs the behavior. Copy + tone come from overflowMeta.
import { Badge } from "@dub/ui";
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
      {meta.label}
    </Badge>
  );
}
