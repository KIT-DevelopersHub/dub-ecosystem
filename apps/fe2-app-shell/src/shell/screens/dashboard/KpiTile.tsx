// A single KPI tile for the Home dashboard. Presentational: an icon chip, a label,
// a big value (with an optional unit), an optional sub-hint, and an optional trailing
// ring gauge or footer meter. A `demo` flag surfaces a small "デモ" tag so illustrative
// numbers are never mistaken for live figures. Colors resolve from @dub/tokens.
import { Icon } from "@dub/ui";
import { toCssVarName } from "@dub/tokens";
import { statusMeta, type MetricStatus } from "./dashboardData.ts";
import { Meter, Ring } from "./DashboardCharts.tsx";

type IconName = Parameters<typeof Icon>[0]["name"];

export interface KpiTileProps {
  icon: IconName;
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  status?: MetricStatus;
  /** Marks the figure as illustrative (renders a "デモ" tag). */
  demo?: boolean;
  ring?: { pct: number; status: MetricStatus; centerLabel?: string; ariaLabel?: string };
  meter?: { pct: number; status: MetricStatus; ariaLabel?: string };
  testId?: string;
}

export function KpiTile({
  icon,
  label,
  value,
  unit,
  hint,
  status = "info",
  demo = false,
  ring,
  meter,
  testId,
}: KpiTileProps): JSX.Element {
  const meta = statusMeta(status);
  return (
    <div className="fe2-kpi" data-status={status} data-testid={testId}>
      <div className="fe2-kpi-top">
        <span
          className="fe2-kpi-icon"
          aria-hidden="true"
          style={{ background: toCssVarName(meta.softColorPath), color: toCssVarName(meta.colorPath) }}
        >
          <Icon name={icon} />
        </span>
        <span className="fe2-kpi-label">{label}</span>
        {demo ? (
          <span className="fe2-kpi-demo" data-testid={testId ? `${testId}-demo` : undefined}>
            デモ
          </span>
        ) : null}
      </div>

      <div className="fe2-kpi-mid">
        <div className="fe2-kpi-figure">
          <span className="fe2-kpi-value" data-testid={testId ? `${testId}-value` : undefined}>
            {value}
          </span>
          {unit ? <span className="fe2-kpi-unit">{unit}</span> : null}
        </div>
        {ring ? (
          <Ring
            pct={ring.pct}
            status={ring.status}
            size={60}
            thickness={7}
            {...(ring.centerLabel !== undefined ? { centerLabel: ring.centerLabel } : {})}
            ariaLabel={ring.ariaLabel ?? label}
          />
        ) : null}
      </div>

      {meter ? <Meter pct={meter.pct} status={meter.status} ariaLabel={meter.ariaLabel ?? label} /> : null}
      {hint ? <p className="fe2-kpi-hint">{hint}</p> : null}
    </div>
  );
}
