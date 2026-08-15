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

/** The halt/bill row — a tinted strip tying the icon + label + one-line detail
 *  together so the overflow consequence is unmistakable at a glance. */
function overflowRow(tone: "info" | "danger"): CSSProperties {
  const softPath = tone === "danger" ? "color.danger.100" : "color.info.100";
  const accentPath = tone === "danger" ? "color.danger.500" : "color.info.500";
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: toCssVarName("space.2"),
    padding: `${toCssVarName("space.2")} ${toCssVarName("space.3")}`,
    borderRadius: toCssVarName("radius.md"),
    background: toCssVarName(softPath),
    borderLeft: `3px solid ${toCssVarName(accentPath)}`,
  };
}

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
    <div data-testid={testRoot} data-status={service.status}>
      <Card>
        <Stack gap={3}>
          {/* header: metric label + status badge */}
          <Stack direction="row" gap={2} align="start" justify="between">
            <span style={label}>{service.label}</span>
            <Badge tone={meta.tone} testId={`${testRoot}-status`}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <Icon name={meta.icon} size="sm" />
                {meta.label}
              </span>
            </Badge>
          </Stack>

          {/* the number + the bar are the focus */}
          <Stack direction="row" gap={2} align="end" justify="between" wrap>
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
          <div style={overflowRow(overflow.tone as "info" | "danger")} data-testid={`${testRoot}-overflow`} data-behavior={service.overflowBehavior}>
            <Icon name={overflow.icon} size="sm" aria-label={overflow.label} />
            <Stack gap={1}>
              <span style={{ ...label, fontSize: toCssVarName("font.size.sm") }}>{overflow.label}</span>
              <span style={muted}>{overflow.detail}</span>
            </Stack>
          </div>

          {/* footer: reset countdown */}
          <span style={muted} data-testid={`${testRoot}-reset`}>
            リセットまで: {formatResetsIn(service.resetsAt, now)}
          </span>
        </Stack>
      </Card>
    </div>
  );
}
