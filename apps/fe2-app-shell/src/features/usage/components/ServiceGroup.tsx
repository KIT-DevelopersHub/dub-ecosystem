// ServiceGroup — one provider section (Cloudflare / Resend / [future GCP] / …): a
// header row (provider name + metric count + the group's worst-status badge) over a
// responsive grid of ServiceUsageCards. Cards arrive already sorted worst-first by
// groupServicesByProvider so problems surface at the top of each section.
import type { CSSProperties } from "react";
import { toCssVarName } from "@dub/tokens";
import { Badge, Icon, Stack } from "@dub/ui";
import { statusMeta, type ServiceGroupData } from "../usageStatus.ts";
import { ServiceUsageCard } from "./ServiceUsageCard.tsx";

const heading: CSSProperties = {
  fontSize: toCssVarName("font.size.lg"),
  fontWeight: toCssVarName("font.weight.bold"),
  color: toCssVarName("color.text.primary"),
};
const count: CSSProperties = { color: toCssVarName("color.text.muted"), fontSize: toCssVarName("font.size.sm") };

/** Responsive auto-fit grid (min 280px columns). Inline (token-spaced) since @dub/ui
 *  Grid is fixed-column; auto-fit is the right fit for a variable card count. */
const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
  gap: toCssVarName("space.4"),
};

export interface ServiceGroupProps {
  group: ServiceGroupData;
  now?: Date;
  testId?: string;
}

export function ServiceGroup({ group, now, testId }: ServiceGroupProps): JSX.Element {
  const meta = statusMeta(group.worstStatus);
  const root = testId ?? `fe2-usage-group-${group.provider}`;

  return (
    <section data-testid={root} data-provider={group.provider}>
      <Stack gap={3}>
        <Stack direction="row" gap={2} align="center" justify="between" wrap>
          <Stack direction="row" gap={2} align="center">
            <span style={heading}>{group.label}</span>
            <span style={count} data-testid={`${root}-count`}>
              {group.services.length} 項目
            </span>
          </Stack>
          <Badge tone={meta.tone} testId={`${root}-worst`}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <Icon name={meta.icon} size="sm" />
              {meta.label}
            </span>
          </Badge>
        </Stack>
        <div style={grid} data-testid={`${root}-grid`}>
          {group.services.map((s) => (
            <ServiceUsageCard key={`${s.provider}:${s.metricKey}`} service={s} now={now} />
          ))}
        </div>
      </Stack>
    </section>
  );
}
