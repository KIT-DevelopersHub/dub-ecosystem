// ServiceUsageCard — one metered quota rendered as a card: label + provider tag,
// status badge, used/limit (+unit), pct, the UsageGauge, reset countdown, and the
// OverflowBadge. Composed entirely from @dub/ui (Card/Stack/Badge) + the feature's
// atoms; every color/space value is a @dub/tokens reference.
import type { CSSProperties } from "react";
import { toCssVarName } from "@dub/tokens";
import { Badge, Card, Stack } from "@dub/ui";
import type { ServiceProvider, ServiceUsage } from "../types.ts";
import { formatAmount, formatPct, formatResetsIn, statusMeta } from "../usageStatus.ts";
import { UsageGauge } from "./UsageGauge.tsx";
import { OverflowBadge } from "./OverflowBadge.tsx";

const PROVIDER_LABEL: Record<string, string> = {
  cloudflare: "Cloudflare",
  resend: "Resend",
};
function providerLabel(p: ServiceProvider): string {
  return PROVIDER_LABEL[p] ?? p;
}

const muted: CSSProperties = { color: toCssVarName("color.text.muted"), fontSize: toCssVarName("font.size.sm") };
const strong: CSSProperties = { fontWeight: 700, fontSize: toCssVarName("font.size.lg") };

export interface ServiceUsageCardProps {
  service: ServiceUsage;
  now?: Date;
  testId?: string;
}

export function ServiceUsageCard({ service, now, testId }: ServiceUsageCardProps): JSX.Element {
  const meta = statusMeta(service.status);
  const unknown = service.status === "unknown";
  const testRoot = testId ?? `fe2-usage-card-${service.metricKey}`;

  return (
    <div data-testid={testRoot} data-status={service.status}>
      <Card>
        <Stack gap={3}>
          {/* header: label + provider, status badge on the right */}
          <Stack direction="row" gap={2} align="center" justify="between">
            <Stack gap={1}>
              <span style={strong}>{service.label}</span>
              <Badge tone="neutral" testId={`${testRoot}-provider`}>
                {providerLabel(service.provider)}
              </Badge>
            </Stack>
            <Badge tone={meta.tone} testId={`${testRoot}-status`}>
              {meta.label}
            </Badge>
          </Stack>

          {/* usage numbers */}
          <Stack direction="row" gap={2} align="center" justify="between" wrap>
            <span style={strong} data-testid={`${testRoot}-pct`}>
              {unknown ? "取得不可" : formatPct(service.pct)}
            </span>
            <span style={muted} data-testid={`${testRoot}-amount`}>
              {unknown ? "使用量を取得できませんでした" : `${formatAmount(service.used)} / ${formatAmount(service.limit)} ${service.unit}`}
            </span>
          </Stack>

          <UsageGauge
            pct={service.pct}
            status={service.status}
            ariaLabel={`${service.label} 使用率`}
            testId={`${testRoot}-gauge`}
          />

          {/* footer: reset countdown + overflow behavior */}
          <Stack direction="row" gap={2} align="center" justify="between" wrap>
            <span style={muted} data-testid={`${testRoot}-reset`}>
              リセットまで: {formatResetsIn(service.resetsAt, now)}
            </span>
            <OverflowBadge behavior={service.overflowBehavior} testId={`${testRoot}-overflow`} />
          </Stack>
        </Stack>
      </Card>
    </div>
  );
}
