// The escalation flow (#902), run by .github/workflows/usage-escalation.yml:
//   usage_snapshot rows (read-only, ~150 rows) -> summary with levels/projection
//   -> for each warn/act/critical metric: top consumers -> open or update ITS GitHub Issue.
// One open Issue per metric (title prefix `[usage:<key>]`), at most one post per metric per
// UTC day unless the level rises (then a comment + the P0 label for critical).
// The GitHub side is a small port so tests run without the network; the real adapter uses
// USAGE_ALERT_GH_TOKEN against the private USAGE_ALERT_REPO (see scripts/usage-escalation.ts).
import { isEscalated, levelRank, type HistoryPoint } from "./escalation";
import { fetchTopConsumers, type ConsumerOptions, type ConsumerResult } from "./consumers";
import { AREA_LABEL, buildComment, buildIssue, postedLevelOn, priorityLabel } from "./issue";
import { MASTER_BY_KEY } from "./limits";
import { playbookFor } from "./playbook";
import { buildSummary, issueTitlePrefix } from "./summary";
import { utcDayString } from "./time";
import type { SnapshotRow, UsageServiceSummary, UsageSummary } from "./types";

// ---------------------------------------------------------------------------
// usage_snapshot rows -> summary
// ---------------------------------------------------------------------------

/** One row of the workflow's read (see SNAPSHOT_SQL). */
export interface HistoryRow {
  provider: string;
  metric_key: string;
  capture_day: string;
  captured_at: string;
  used: number | null;
  pct: number | null;
  status: string;
}

/** The workflow's only D1 read: the last 8 days via idx_usage_snapshot_day (~15 x 9 rows). */
export const SNAPSHOT_SQL =
  "SELECT provider, metric_key, capture_day, captured_at, used, pct, status FROM usage_snapshot " +
  "WHERE capture_day >= date('now', '-8 days') AND status != 'unknown'";

/** Latest known reading per metric + earlier readings for the growth projection. */
export function summaryFromHistory(rows: readonly HistoryRow[], now: Date): UsageSummary {
  const latest = new Map<string, HistoryRow>();
  const history = new Map<string, HistoryPoint[]>();
  for (const r of rows) {
    const def = MASTER_BY_KEY.get(r.metric_key);
    if (!def || r.provider !== def.provider) continue;
    const cur = latest.get(r.metric_key);
    if (!cur || r.captured_at > cur.captured_at) latest.set(r.metric_key, r);
    if (r.used !== null) {
      const list = history.get(r.metric_key) ?? [];
      list.push({ day: r.capture_day, used: r.used });
      history.set(r.metric_key, list);
    }
  }
  const snap: SnapshotRow[] = [...latest.values()].map((r) => {
    const def = MASTER_BY_KEY.get(r.metric_key)!;
    return {
      provider: def.provider,
      metric_key: def.metricKey,
      label: def.label,
      used: r.used,
      limit_value: def.limit,
      pct: r.pct,
      unit: def.unit,
      overflow_behavior: def.overflowBehavior,
      status: r.status as SnapshotRow["status"],
      captured_at: r.captured_at,
    };
  });
  const capturedAt = snap.reduce<string | null>((m, r) => (r.captured_at && (!m || r.captured_at > m) ? r.captured_at : m), null);
  return buildSummary(snap, now, capturedAt, history);
}

// ---------------------------------------------------------------------------
// GitHub port
// ---------------------------------------------------------------------------

export interface OpenIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

export interface IssuesPort {
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  listOpen(label: string): Promise<OpenIssue[]>;
  listCommentBodies(number: number): Promise<string[]>;
  create(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }>;
  comment(number: number, body: string): Promise<void>;
  addLabels(number: number, labels: string[]): Promise<void>;
  removeLabel(number: number, label: string): Promise<void>;
}

export interface GithubRestOptions {
  token: string;
  repo: string; // owner/name
  fetch?: typeof fetch;
}

/** GitHub REST adapter for the alert repo (fine-grained token, Issues: write). */
export function githubRest(opts: GithubRestOptions): IssuesPort {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = `https://api.github.com/repos/${opts.repo}`;
  async function call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T | null> {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "dub-usage-escalation",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (okStatuses.includes(res.status)) return null;
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`);
    return res.status === 204 ? null : ((await res.json()) as T);
  }
  return {
    async ensureLabel(name, color, description) {
      // 422 = already exists.
      await call("POST", "/labels", { name, color, description }, [422]);
    },
    async listOpen(label) {
      const rows =
        (await call<{ number: number; title: string; body: string | null; html_url: string; labels: { name: string }[]; pull_request?: unknown }[]>(
          "GET",
          `/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`,
        )) ?? [];
      return rows
        .filter((r) => !r.pull_request)
        .map((r) => ({ number: r.number, title: r.title, body: r.body ?? "", labels: r.labels.map((l) => l.name), url: r.html_url }));
    },
    async listCommentBodies(number) {
      const rows = (await call<{ body: string }[]>("GET", `/issues/${number}/comments?per_page=100`)) ?? [];
      return rows.map((r) => r.body);
    },
    async create(title, body, labels) {
      const r = await call<{ number: number; html_url: string }>("POST", "/issues", { title, body, labels });
      return { number: r!.number, url: r!.html_url };
    },
    async comment(number, body) {
      await call("POST", `/issues/${number}/comments`, { body });
    },
    async addLabels(number, labels) {
      await call("POST", `/issues/${number}/labels`, { labels });
    },
    async removeLabel(number, label) {
      await call("DELETE", `/issues/${number}/labels/${encodeURIComponent(label)}`, undefined, [404]);
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type EscalationAction =
  | { metricKey: string; action: "created"; level: string; number: number; url: string }
  | { metricKey: string; action: "commented"; level: string; number: number }
  | { metricKey: string; action: "skipped"; level: string; number: number; reason: string }
  | { metricKey: string; action: "planned"; level: string; title: string; body: string; labels: string[] };

export interface RunEscalationOptions {
  now: Date;
  /** null = dry run: render what would be posted, call nothing on GitHub. */
  issues: IssuesPort | null;
  consumers: Omit<ConsumerOptions, "now">;
  /** Injectable for tests. */
  topConsumers?: (s: UsageServiceSummary) => Promise<ConsumerResult>;
}

export async function runEscalation(summary: UsageSummary, opts: RunEscalationOptions): Promise<EscalationAction[]> {
  const day = utcDayString(opts.now);
  const targets = summary.services.filter((s) => isEscalated(s.level));
  const top =
    opts.topConsumers ??
    ((s: UsageServiceSummary) => fetchTopConsumers(playbookFor(s.metricKey).consumers, { ...opts.consumers, now: opts.now }));
  const out: EscalationAction[] = [];
  if (targets.length === 0) return out;

  if (summary.stale) {
    // Old numbers must not open Issues; the Worker already mails "collection stopped".
    return out;
  }

  const open = opts.issues ? await opts.issues.listOpen(AREA_LABEL) : [];
  if (opts.issues) {
    // The alert repo (dub-docs) may not have these yet; 422 = already there.
    await opts.issues.ensureLabel(AREA_LABEL, "c2e0c6", "無料枠の使用量（usage-escalation）");
    await opts.issues.ensureLabel("P1", "fbca04", "優先度: 高");
    await opts.issues.ensureLabel("P0", "b60205", "優先度: 最優先");
  }

  for (const s of targets) {
    const existing = open.find((i) => i.title.startsWith(issueTitlePrefix(s.metricKey)));
    if (existing && opts.issues) {
      const posted = postedLevelOn([existing.body, ...(await opts.issues.listCommentBodies(existing.number))], s.metricKey, day);
      if (posted !== null && levelRank(posted) >= levelRank(s.level)) {
        out.push({ metricKey: s.metricKey, action: "skipped", level: s.level, number: existing.number, reason: `already posted ${posted} today` });
        continue;
      }
      await opts.issues.comment(existing.number, buildComment(s, day, summary.capturedAt, await top(s)));
      const want = priorityLabel(s.level);
      if (!existing.labels.includes(want)) {
        await opts.issues.addLabels(existing.number, [want]);
        if (want === "P0") await opts.issues.removeLabel(existing.number, "P1");
      }
      out.push({ metricKey: s.metricKey, action: "commented", level: s.level, number: existing.number });
      continue;
    }
    const post = buildIssue(s, day, summary.capturedAt, await top(s));
    if (!opts.issues) {
      out.push({ metricKey: s.metricKey, action: "planned", level: s.level, ...post });
      continue;
    }
    const created = await opts.issues.create(post.title, post.body, post.labels);
    out.push({ metricKey: s.metricKey, action: "created", level: s.level, ...created });
  }
  return out;
}
