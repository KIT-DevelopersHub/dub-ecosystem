// EscalationPanel (#902) — the "what now" strip under a usage card: the run-out estimate,
// what to do at this level, the metric's open GitHub Issue (where 対策 / 課金 is decided)
// and its playbook, plus what paying would cost. Built from @dub/ui + @dub/tokens only.
import type { CSSProperties } from "react";
import { toCssVarName } from "@dub/tokens";
import { Icon, Skeleton, Stack } from "@dub/ui";
import type { ServiceUsage, UsageIssue } from "../types.ts";
import { effectiveLevel, formatProjection, isEscalatedLevel, levelMeta } from "../usageStatus.ts";

/** The Issue lookup for one card: still loading, or done (issue may be absent). */
export type IssueLinkState = { loading: true } | { loading: false; issue?: UsageIssue };

const line: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: toCssVarName("space.2"),
  fontSize: toCssVarName("font.size.sm"),
  color: toCssVarName("color.text.secondary"),
  lineHeight: 1.6,
};
const muted: CSSProperties = { ...line, color: toCssVarName("color.text.muted") };
const link: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: toCssVarName("space.1"),
  fontSize: toCssVarName("font.size.sm"),
  color: toCssVarName("color.text.link"),
  textDecoration: "none",
  fontWeight: toCssVarName("font.weight.medium"),
};

function ExternalLink({ href, testId, children }: { href: string; testId: string; children: string }): JSX.Element {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={link} data-testid={testId}>
      {children}
      <Icon name="external-link" size="sm" aria-hidden="true" />
    </a>
  );
}

export interface EscalationPanelProps {
  service: ServiceUsage;
  issue: IssueLinkState;
  now?: Date;
  testId: string;
}

export function EscalationPanel({ service, issue, now, testId }: EscalationPanelProps): JSX.Element | null {
  const level = effectiveLevel(service);
  if (level === "unknown") return null;
  const escalated = isEscalatedLevel(level);
  const projection = formatProjection(service.projection, now);
  const meta = levelMeta(level);
  if (!projection && !escalated && !service.playbookUrl) return null;

  let issueLink: JSX.Element | null = null;
  if (issue.loading) {
    issueLink = <Skeleton width={96} height={16} testId={`${testId}-issue-skeleton`} />;
  } else if (issue.issue) {
    issueLink = (
      <ExternalLink href={issue.issue.url} testId={`${testId}-issue`}>
        {`Issue #${issue.issue.number} で決める`}
      </ExternalLink>
    );
  } else if (escalated && service.issueSearchUrl) {
    issueLink = (
      <ExternalLink href={service.issueSearchUrl} testId={`${testId}-issue-search`}>
        Issue を探す
      </ExternalLink>
    );
  }

  return (
    <div data-testid={testId} data-level={level}>
      <Stack gap={2}>
        {projection && (
          <span style={line} data-testid={`${testId}-projection`}>
            <Icon name="clock" size="sm" aria-hidden="true" />
            <span>{projection}</span>
          </span>
        )}
        {escalated && (
          <span style={line} data-testid={`${testId}-action`}>
            <Icon name={meta.icon} size="sm" aria-hidden="true" />
            <span>
              <strong>{meta.label}</strong>: {meta.action}
            </span>
          </span>
        )}
        {(issueLink || service.playbookUrl) && (
          <Stack direction="row" gap={4} align="center" wrap>
            {issueLink}
            {service.playbookUrl && (
              <ExternalLink href={service.playbookUrl} testId={`${testId}-playbook`}>
                手順書
              </ExternalLink>
            )}
          </Stack>
        )}
        {escalated && service.paidPlan && (
          <span style={muted} data-testid={`${testId}-paid`}>
            課金する場合: {service.paidPlan.name}・{service.paidPlan.price}
          </span>
        )}
      </Stack>
    </div>
  );
}
