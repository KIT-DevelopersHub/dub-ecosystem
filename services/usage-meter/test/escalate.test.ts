import { describe, it, expect } from "vitest";
import { runEscalation, summaryFromHistory, type HistoryRow, type IssuesPort, type OpenIssue } from "../src/escalate";
import { fetchTopConsumers, topLines } from "../src/consumers";
import { marker, postedLevelOn } from "../src/issue";
import { DEFAULT_ALERT_REPO, resolveAlertRepo } from "../src/playbook";
import { issueSearchUrl } from "../src/summary";

const NOW = new Date("2026-11-27T12:00:00Z");

function rows(pctRead: number): HistoryRow[] {
  return [
    { provider: "cloudflare", metric_key: "d1_rows_read_day", capture_day: "2026-11-27", captured_at: "2026-11-27T11:00:00Z", used: pctRead * 50_000, pct: pctRead, status: "warn" },
    { provider: "cloudflare", metric_key: "d1_rows_read_day", capture_day: "2026-11-26", captured_at: "2026-11-26T11:00:00Z", used: 1, pct: 0, status: "ok" },
    { provider: "cloudflare", metric_key: "workers_requests_day", capture_day: "2026-11-27", captured_at: "2026-11-27T11:00:00Z", used: 10_000, pct: 10, status: "ok" },
  ];
}

function fakeIssues(open: OpenIssue[] = [], comments: Record<number, string[]> = {}) {
  const log: string[] = [];
  const port: IssuesPort = {
    async ensureLabel(n) { log.push(`label ${n}`); },
    async listOpen() { return open; },
    async listCommentBodies(n) { return comments[n] ?? []; },
    async create(title, body, labels) { log.push(`create ${title} [${labels.join(",")}]`); open.push({ number: 99, title, body, labels, url: "u" }); return { number: 99, url: "u" }; },
    async comment(n, body) { log.push(`comment ${n}`); (comments[n] ??= []).push(body); },
    async addLabels(n, l) { log.push(`add ${n} ${l.join(",")}`); },
    async removeLabel(n, l) { log.push(`remove ${n} ${l}`); },
  };
  return { port, log };
}

const noConsumers = async () => ({ lines: [{ name: "`SELECT 1`", value: 10, share: 100 }] });

describe("summaryFromHistory", () => {
  it("takes the latest reading per metric and ignores unknown metric keys", () => {
    const s = summaryFromHistory([...rows(88), { provider: "cloudflare", metric_key: "nope", capture_day: "2026-11-27", captured_at: "2026-11-27T11:00:00Z", used: 1, pct: 1, status: "ok" }], NOW);
    const d1 = s.services.find((x) => x.metricKey === "d1_rows_read_day")!;
    expect(d1.pct).toBe(88);
    expect(d1.level).toBe("act");
    expect(s.capturedAt).toBe("2026-11-27T11:00:00Z");
  });
});

describe("runEscalation", () => {
  it("creates one Issue per escalated metric with area:usage + P1, then skips the same day", async () => {
    const { port, log } = fakeIssues();
    const summary = summaryFromHistory(rows(88), NOW);
    const first = await runEscalation(summary, { now: NOW, issues: port, consumers: { token: null, accountId: null }, topConsumers: noConsumers });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ metricKey: "d1_rows_read_day", action: "created", level: "act" });
    expect(log).toContain("create [usage:d1_rows_read_day] D1 行読み取り(日) が無料枠の 88%（対策） [area:usage,P1]");
    const again = await runEscalation(summary, { now: NOW, issues: port, consumers: { token: null, accountId: null }, topConsumers: noConsumers });
    expect(again[0]).toMatchObject({ action: "skipped" });
  });

  it("comments and moves to P0 when the level rises the same day", async () => {
    const open: OpenIssue[] = [{ number: 5, title: "[usage:d1_rows_read_day] old", body: marker("d1_rows_read_day", "2026-11-27", "act"), labels: ["area:usage", "P1"], url: "u" }];
    const { port, log } = fakeIssues(open);
    const out = await runEscalation(summaryFromHistory(rows(96), NOW), { now: NOW, issues: port, consumers: { token: null, accountId: null }, topConsumers: noConsumers });
    expect(out[0]).toMatchObject({ action: "commented", level: "critical", number: 5 });
    expect(log).toEqual(expect.arrayContaining(["comment 5", "add 5 P0", "remove 5 P1"]));
  });

  it("renders the Issue sections in a dry run without touching GitHub", async () => {
    const out = await runEscalation(summaryFromHistory(rows(88), NOW), { now: NOW, issues: null, consumers: { token: null, accountId: null }, topConsumers: noConsumers });
    expect(out[0]?.action).toBe("planned");
    if (out[0]?.action !== "planned") return;
    for (const h of ["## 状況", "## 何が使っているか", "## 対策（手順書から）", "## 課金するか", "Workers Paid", "d1-rows-read.md", "SELECT 1"]) {
      expect(out[0].body).toContain(h);
    }
    expect(out[0].labels).toEqual(["area:usage", "P1"]);
  });

  it("never opens Issues from stale numbers", async () => {
    const old = rows(96).map((r) => ({ ...r, captured_at: "2026-11-20T11:00:00Z" }));
    const { port, log } = fakeIssues();
    expect(await runEscalation(summaryFromHistory(old, NOW), { now: NOW, issues: port, consumers: { token: null, accountId: null }, topConsumers: noConsumers })).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe("postedLevelOn", () => {
  it("returns the highest level posted for that metric on that day", () => {
    const texts = [marker("a", "2026-11-27", "warn"), `x ${marker("a", "2026-11-27", "act")}`, marker("a", "2026-11-26", "critical"), marker("b", "2026-11-27", "critical")];
    expect(postedLevelOn(texts, "a", "2026-11-27")).toBe("act");
    expect(postedLevelOn(texts, "c", "2026-11-27")).toBeNull();
  });
});

describe("top consumers", () => {
  it("merges, ranks and shares", () => {
    expect(topLines([{ name: "a", value: 1 }, { name: "b", value: 3 }, { name: "a", value: 1 }])).toEqual([
      { name: "b", value: 3, share: 60 },
      { name: "a", value: 2, share: 40 },
    ]);
  });
  it("reads d1QueriesAdaptiveGroups and degrades to an error on GraphQL errors", async () => {
    let sent = "";
    const ok = (async (_u: unknown, init?: RequestInit) => {
      sent = String(init?.body);
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1QueriesAdaptiveGroups: [{ sum: { rowsRead: 900 }, dimensions: { query: "SELECT  *\n FROM t" } }] }] } } }));
    }) as typeof fetch;
    const r = await fetchTopConsumers("d1_rows_read", { token: "t", accountId: "acc", now: NOW, fetch: ok });
    expect(sent).toContain("orderBy:[sum_rowsRead_DESC]");
    expect(r).toEqual({ lines: [{ name: "`SELECT * FROM t`", value: 900, share: 100 }] });
    const bad = (async () => new Response(JSON.stringify({ data: null, errors: [{ message: "boom" }] }))) as typeof fetch;
    expect(await fetchTopConsumers("kv", { token: "t", accountId: "acc", now: NOW, fetch: bad })).toEqual({ error: "GraphQL: boom" });
    expect(await fetchTopConsumers("workers", { token: null, accountId: "acc", now: NOW })).toHaveProperty("error");
    expect(await fetchTopConsumers("email", { token: null, accountId: null, now: NOW })).toHaveProperty("note");
  });
});

describe("alert repo (Issues go to a private repo)", () => {
  it("defaults to dub-docs and refuses the public dub-ecosystem or a malformed value", () => {
    expect(resolveAlertRepo(undefined)).toBe(DEFAULT_ALERT_REPO);
    expect(resolveAlertRepo("  ")).toBe("KIT-DevelopersHub/dub-docs");
    expect(resolveAlertRepo("acme/private-ops")).toBe("acme/private-ops");
    expect(resolveAlertRepo("KIT-DevelopersHub/dub-ecosystem")).toBeNull();
    expect(resolveAlertRepo("kit-developershub/DUB-ECOSYSTEM")).toBeNull();
    expect(resolveAlertRepo("https://github.com/x/y")).toBeNull();
  });
  it("the dashboard search link follows USAGE_ALERT_REPO and never points at dub-ecosystem", () => {
    expect(issueSearchUrl("kv_reads_day")).toMatch(/^https:\/\/github\.com\/KIT-DevelopersHub\/dub-docs\/issues\?q=/);
    expect(issueSearchUrl("kv_reads_day", "acme/ops")).toMatch(/^https:\/\/github\.com\/acme\/ops\/issues/);
    expect(issueSearchUrl("kv_reads_day", "KIT-DevelopersHub/dub-ecosystem")).toContain("/dub-docs/");
  });
});
