// PR CI badge + 「確認」: normalization/summary, eligibility, and the confirm route against a
// mocked GitHub (no real network, no real label). Audit rows checked on the real schema.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import {
  confirmEligibility,
  normalizeChecks,
  summarize,
  type RawCheckNode,
} from "../src/github";
import { clearChecksCache } from "../src/prs";
import { makeD1 } from "./d1";

const TOKEN = "test-operator-token";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

const run = (name: string, status: string, conclusion: string | null, isRequired = false): RawCheckNode => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/x/actions/${name}`,
  isRequired,
});

describe("normalizeChecks / summarize", () => {
  it("maps CheckRun and StatusContext states and sorts failures first", () => {
    const checks = normalizeChecks([
      run("typecheck", "COMPLETED", "SUCCESS"),
      run("e2e", "IN_PROGRESS", null),
      run("lint", "COMPLETED", "FAILURE"),
      run("docs", "COMPLETED", "SKIPPED"),
      { __typename: "StatusContext", context: "cf/pages", state: "ERROR", targetUrl: null },
      null,
    ]);
    expect(checks.map((c) => [c.name, c.state])).toEqual([
      ["cf/pages", "fail"],
      ["lint", "fail"],
      ["e2e", "pending"],
      ["typecheck", "pass"],
      ["docs", "skipped"],
    ]);
  });

  it("excludes skipped and the confirm-gate label check from the counts", () => {
    const s = summarize(
      normalizeChecks([
        run("a", "COMPLETED", "SUCCESS"),
        run("b", "COMPLETED", "SUCCESS"),
        run("c", "COMPLETED", "FAILURE"),
        run("confirm-gate", "COMPLETED", "FAILURE"),
        run("skip", "COMPLETED", "NEUTRAL"),
      ]),
    );
    expect(s).toMatchObject({ state: "fail", passed: 2, total: 3, failing: ["c"], pending: 0 });
  });

  it("uses required checks when branch protection marks some, otherwise all", () => {
    const some = summarize(
      normalizeChecks([run("req", "COMPLETED", "SUCCESS", true), run("opt", "COMPLETED", "FAILURE", false)]),
    );
    expect(some.requiredNotPassing).toEqual([]);
    const none = summarize(normalizeChecks([run("x", "COMPLETED", "SUCCESS"), run("y", "QUEUED", null)]));
    expect(none.state).toBe("pending");
    expect(none.requiredNotPassing).toEqual(["y"]);
  });

  it("reports none when no checks exist", () => {
    expect(summarize([]).state).toBe("none");
  });
});

describe("confirmEligibility", () => {
  const green = summarize(normalizeChecks([run("a", "COMPLETED", "SUCCESS")]));
  const red = summarize(normalizeChecks([run("a", "COMPLETED", "FAILURE")]));
  const pr = { state: "OPEN" as const, isDraft: false, confirmed: false, viewerPermission: "WRITE", summary: green };
  const on = { enabled: true, policy: "block" as const };

  it("allows an open, green, unlabeled PR", () => {
    expect(confirmEligibility(pr, on)).toEqual({ allowed: true, reason: null, warnings: [] });
  });
  it.each([
    [{ ...pr }, { enabled: false, policy: "block" as const }, "confirm_disabled"],
    [{ ...pr, state: "MERGED" as const }, on, "pr_merged"],
    [{ ...pr, state: "CLOSED" as const }, on, "pr_closed"],
    [{ ...pr, confirmed: true }, on, "already_confirmed"],
    [{ ...pr, isDraft: true }, on, "pr_draft"],
    [{ ...pr, viewerPermission: "READ" }, on, "token_insufficient"],
    [{ ...pr, viewerPermission: null }, on, "token_insufficient"],
    [{ ...pr, summary: red }, on, "checks_not_green"],
  ])("blocks %#", (input, opts, reason) => {
    expect(confirmEligibility(input, opts)).toMatchObject({ allowed: false, reason });
  });
  it("warn policy allows red CI with a warning", () => {
    const r = confirmEligibility({ ...pr, summary: red }, { enabled: true, policy: "warn" });
    expect(r.allowed).toBe(true);
    expect(r.warnings[0]).toMatch(/a/);
  });
});

// ── routes with a mocked GitHub ───────────────────────────────────────────────────────

interface FakePr {
  state?: "OPEN" | "CLOSED" | "MERGED";
  labels?: string[];
  head?: string;
  permission?: string;
  checks?: RawCheckNode[];
  labelStatus?: number;
}

function githubMock(p: FakePr = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer gh-test-token");
    if (url.endsWith("/graphql")) {
      return Response.json({
        data: {
          viewer: { login: "owner-login" },
          repository: {
            viewerPermission: p.permission ?? "ADMIN",
            pullRequest: {
              number: 42,
              title: "PR title",
              url: "https://github.com/KIT-DevelopersHub/dub-ecosystem/pull/42",
              state: p.state ?? "OPEN",
              isDraft: false,
              mergeStateStatus: "BLOCKED",
              headRefOid: p.head ?? SHA,
              labels: { nodes: (p.labels ?? ["stagingへ"]).map((name) => ({ name })) },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: p.checks ?? [run("ci", "COMPLETED", "SUCCESS"), run("confirm-gate", "COMPLETED", "FAILURE")],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (url.endsWith("/issues/42/labels")) {
      return new Response("{}", { status: p.labelStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  });
  return { fn, calls };
}

describe("PR routes", () => {
  let env: Env;
  let raw: ReturnType<typeof makeD1>["raw"];

  beforeEach(() => {
    clearChecksCache();
    const d1 = makeD1();
    raw = d1.raw;
    env = {
      DB: d1.d1,
      COMMANDER_OPERATOR_TOKEN: TOKEN,
      COMMANDER_GITHUB_TOKEN: "gh-test-token",
      COMMANDER_PR_CONFIRM_ENABLED: "1",
    };
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await createApp().fetch(
      new Request(`http://x${path}`, {
        method,
        headers: { "content-type": "application/json", "x-commander-token": TOKEN },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env as never,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (await res.json()) as any };
  }

  function auditRows() {
    return raw.prepare("SELECT * FROM commander_pr_confirmations ORDER BY created_at").all() as Record<string, unknown>[];
  }

  it("GET checks: one GraphQL call, normalized + cached", async () => {
    const gh = githubMock();
    vi.stubGlobal("fetch", gh.fn);
    const r = await call("GET", "/prs/42/checks");
    expect(r.status).toBe(200);
    expect(r.json.pr.summary).toMatchObject({ state: "pass", passed: 1, total: 1 });
    expect(r.json.pr.staging).toEqual({ stagingへ: true, staging2へ: false });
    expect(r.json.pr.confirmed).toBe(false);
    expect(r.json.confirm).toEqual({ allowed: true, reason: null, warnings: [] });
    await call("GET", "/prs/42/checks");
    expect(gh.fn).toHaveBeenCalledTimes(1); // second read served from cache
    await call("GET", "/prs/42/checks?fresh=1");
    expect(gh.fn).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("rejects another repo and a missing token", async () => {
    vi.stubGlobal("fetch", githubMock().fn);
    expect((await call("GET", "/prs/42/checks?repo=evil/repo")).json.error).toBe("repo_not_allowed");
    env.COMMANDER_GITHUB_TOKEN = undefined;
    const r = await call("GET", "/prs/42/checks");
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("github_not_configured");
    vi.unstubAllGlobals();
  });

  it("confirm: adds 確認した and audits who/which commit", async () => {
    const gh = githubMock();
    vi.stubGlobal("fetch", gh.fn);
    const r = await call("POST", "/prs/42/confirm", { headSha: SHA });
    expect(r.status).toBe(200);
    expect(r.json.result).toBe("labeled");
    expect(r.json.pr.confirmed).toBe(true);
    const labelCall = gh.calls.find((c) => c.url.endsWith("/repos/KIT-DevelopersHub/dub-ecosystem/issues/42/labels"));
    expect(labelCall?.body).toEqual({ labels: ["確認した"] });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo: "KIT-DevelopersHub/dub-ecosystem",
      pr_number: 42,
      head_sha: SHA,
      github_login: "owner-login",
      result: "labeled",
      label: "確認した",
    });
    vi.unstubAllGlobals();
  });

  it.each([
    [{ state: "MERGED" as const }, 409, "pr_merged"],
    [{ state: "CLOSED" as const }, 409, "pr_closed"],
    [{ permission: "READ" }, 403, "token_insufficient"],
    [{ checks: [run("ci", "COMPLETED", "FAILURE")] }, 409, "checks_not_green"],
    [{ head: "ffffffffffffffffffffffffffffffffffffffff" }, 409, "head_moved"],
  ])("confirm refuses %o without calling the label API, and audits it", async (pr, status, error) => {
    const gh = githubMock(pr);
    vi.stubGlobal("fetch", gh.fn);
    const r = await call("POST", "/prs/42/confirm", { headSha: SHA });
    expect(r.status).toBe(status);
    expect(r.json.error).toBe(error);
    expect(gh.calls.some((c) => c.url.includes("/labels"))).toBe(false);
    expect(auditRows()[0]).toMatchObject({ result: "refused", reason: error });
    vi.unstubAllGlobals();
  });

  it("confirm is idempotent when already labeled (no second label call)", async () => {
    const gh = githubMock({ labels: ["確認した"] });
    vi.stubGlobal("fetch", gh.fn);
    const r = await call("POST", "/prs/42/confirm", { headSha: SHA });
    expect(r.status).toBe(200);
    expect(r.json.result).toBe("already_confirmed");
    expect(gh.calls.some((c) => c.url.includes("/labels"))).toBe(false);
    expect(auditRows()[0]).toMatchObject({ result: "already_confirmed" });
    vi.unstubAllGlobals();
  });

  it("maps a 403 from the label API to token_insufficient", async () => {
    vi.stubGlobal("fetch", githubMock({ labelStatus: 403 }).fn);
    const r = await call("POST", "/prs/42/confirm", { headSha: SHA });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("token_insufficient");
    expect(auditRows()[0]).toMatchObject({ result: "error", reason: "github_forbidden" });
    vi.unstubAllGlobals();
  });

  it("warn policy lets red CI through", async () => {
    env.COMMANDER_CONFIRM_CHECKS_POLICY = "warn";
    vi.stubGlobal("fetch", githubMock({ checks: [run("ci", "COMPLETED", "FAILURE")] }).fn);
    const r = await call("POST", "/prs/42/confirm", { headSha: SHA });
    expect(r.status).toBe(200);
    expect(r.json.warnings[0]).toMatch(/ci/);
    vi.unstubAllGlobals();
  });

  it("requires headSha", async () => {
    const r = await call("POST", "/prs/42/confirm", {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("head_sha_required");
  });
});
