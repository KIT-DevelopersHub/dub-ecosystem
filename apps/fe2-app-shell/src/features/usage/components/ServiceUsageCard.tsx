// ServiceUsageCard — one metered quota. The progress bar + big % are the visual
// focus (requirement 1); the halt/bill distinction gets its own tinted row so the
// reader instantly sees whether hitting 100% costs money or just stops (requirement
// 3). Composed entirely from @dub/ui (Card/Stack/Badge/Icon) + the feature's atoms;
// every color/space value is a @dub/tokens reference.
import type { CSSProperties } from "react";
import { toCssVarName } from "@dub/tokens";
import { Badge, Card, Icon, Stack } from "@dub/ui";
import type { ServiceUsage } from "../types.ts";
import { formatPct, formatResetsIn, formatUsage, overflowMeta, statusMeta } from "../usageStatus.ts";
import { UsageGauge } from "./UsageGauge.tsx";

const label: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontWeight: toCssVarName("font.weight.medium"),
  fontSize: toCssVarName("font.size.md"),
  color: toCssVarName("color.text.primary"),
};
const muted: CSSProperties = { color: toCssVarName("color.text.muted"), fontSize: toCssVarName("font.size.sm") };
const amount: CSSProperties = {
  color: toCssVarName("color.text.secondary"),
  fontSize: toCssVarName("font.size.sm"),
  fontFamily: toCssVarName("font.family.mono"),
};

function pctStyle(colorPath: string, unknown: boolean): CSSProperties {
  return {
    fontSize: toCssVarName("font.size.3xl"),
    fontWeight: toCssVarName("font.weight.bold"),
    lineHeight: 1,
    color: unknown ? toCssVarName("color.text.muted") : toCssVarName(colorPath),
  };
}

/** bill is the exception that costs money, so only it gets the tinted strip. halt is
 *  the common safe case: one quiet line, so the warning is not lost among repeats. */
const billRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: toCssVarName("space.2"),
  padding: `${toCssVarName("space.2")} ${toCssVarName("space.3")}`,
  borderRadius: toCssVarName("radius.md"),
  background: toCssVarName("color.danger.100"),
  borderLeft: `3px solid ${toCssVarName("color.danger.500")}`,
};
const haltRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: toCssVarName("space.1"),
  color: toCssVarName("color.text.secondary"),
  fontSize: toCssVarName("font.size.sm"),
};
const noShrink: CSSProperties = { display: "inline-flex", flexShrink: 0 };
const badgeInner: CSSProperties = { display: "inline-flex", alignItems: "center", gap: "4px", whiteSpace: "nowrap" };
// Fills the grid row so cards in one row share a height.
const cardWrap: CSSProperties = { display: "grid" };

export interface ServiceUsageCardProps {
  service: ServiceUsage;
  now?: Date;
  testId?: string;
}

export function ServiceUsageCard({ service, now, testId }: ServiceUsageCardProps): JSX.Element {
  const meta = statusMeta(service.status);
  const overflow = overflowMeta(service.overflowBehavior);
  const unknown = service.status === "unknown";
  const testRoot = testId ?? `fe2-usage-card-${service.metricKey}`;

  return (
    <div data-testid={testRoot} data-status={service.status} style={cardWrap}>
      <Card>
        <Stack gap={3}>
          {/* header: metric label + status badge */}
          <Stack direction="row" gap={2} align="start" justify="between">
            <span style={label}>{service.label}</span>
            <Badge tone={meta.tone} testId={`${testRoot}-status`}>
              <span style={badgeInner}>
                <Icon name={meta.icon} size="sm" />
                {meta.label}
              </span>
            </Badge>
          </Stack>

          {/* the number + the bar are the focus */}
          <Stack gap={1}>
            <span style={pctStyle(meta.colorPath, unknown)} data-testid={`${testRoot}-pct`}>
              {unknown ? "取得不可" : formatPct(service.pct)}
            </span>
            <span style={amount} data-testid={`${testRoot}-amount`}>
              {unknown ? "使用量を取得できませんでした" : formatUsage(service.used, service.limit, service.unit)}
            </span>
          </Stack>

          <UsageGauge
            pct={service.pct}
            status={service.status}
            ariaLabel={`${service.label} 使用率`}
            testId={`${testRoot}-gauge`}
          />

          {/* the halt/bill consequence — the key clarity signal */}
          {service.overflowBehavior === "bill" ? (
            <div style={billRow} data-testid={`${testRoot}-overflow`} data-behavior="bill">
              <span style={noShrink}>
                <Icon name={overflow.icon} size="sm" aria-label={overflow.label} />
              </span>
              <Stack gap={1}>
                <span style={{ ...label, fontSize: toCssVarName("font.size.sm") }}>{overflow.label}</span>
                <span style={muted}>{overflow.detail}</span>
              </Stack>
            </div>
          ) : (
            <div style={haltRow} title={overflow.detail} data-testid={`${testRoot}-overflow`} data-behavior="halt">
              <span style={noShrink}>
                <Icon name={overflow.icon} size="sm" aria-hidden="true" />
              </span>
              {overflow.label}
            </div>
          )}

          {/* footer: reset countdown (cumulative metrics like storage never reset) */}
          <span style={muted} data-testid={`${testRoot}-reset`}>
            {service.resetsAt === null ? "累積値（期間リセットなし）" : `リセットまで: ${formatResetsIn(service.resetsAt, now)}`}
          </span>
        </Stack>
      </Card>
    </div>
  );
}
