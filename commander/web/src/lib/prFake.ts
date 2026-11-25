// In-memory PrChecksApi for tests and the demo mode (VITE_COMMANDER_DEMO) (no GitHub, no network).
import type { PrCheck, PrChecks, PrChecksApi, PrChecksView, PrRef } from "./prChecks.ts";
import { blockerText } from "./prChecks.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

export function makePr(over: Partial<PrChecks> & { checks?: PrCheck[] } = {}): PrChecks {
  const checks = [...(over.checks ?? [
    { name: "ci / typecheck", state: "pass", url: "https://github.com/x/1", required: true, labelGate: false },
    { name: "ci / test", state: "pass", url: "https://github.com/x/2", required: true, labelGate: false },
    { name: "confirm-gate", state: "fail", url: "https://github.com/x/3", required: true, labelGate: true },
  ])] as PrCheck[];
  const rank = { fail: 0, pending: 1, pass: 2, skipped: 3 } as const;
  checks.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  const counted = checks.filter((c) => !c.labelGate && c.state !== "skipped");
  const failing = counted.filter((c) => c.state === "fail").map((c) => c.name);
  const pending = counted.filter((c) => c.state === "pending").length;
  const labels = over.labels ?? ["stagingへ"];
  return {
    repo: "KIT-DevelopersHub/dub-ecosystem",
    number: 101,
    title: "サンプル PR",
    url: "https://github.com/KIT-DevelopersHub/dub-ecosystem/pull/101",
    state: "OPEN",
    isDraft: false,
    headSha: SHA,
    mergeStateStatus: "BLOCKED",
    viewerPermission: "ADMIN",
    viewerLogin: "owner",
    ...over,
    labels,
    confirmed: labels.includes("確認した"),
    staging: { stagingへ: labels.includes("stagingへ"), staging2へ: labels.includes("staging2へ") },
    checks,
    summary: {
      state: counted.length === 0 ? "none" : failing.length ? "fail" : pending ? "pending" : "pass",
      passed: counted.filter((c) => c.state === "pass").length,
      total: counted.length,
      pending,
      failing,
      requiredNotPassing: counted.filter((c) => c.state !== "pass").map((c) => c.name),
    },
  };
}

function eligibility(pr: PrChecks) {
  const reason =
    pr.state === "MERGED" ? "pr_merged"
    : pr.state === "CLOSED" ? "pr_closed"
    : pr.confirmed ? "already_confirmed"
    : pr.summary.requiredNotPassing.length ? "checks_not_green"
    : null;
  return { allowed: reason === null, reason, warnings: [] };
}

export interface FakePrApi extends PrChecksApi {
  prs: Map<number, PrChecks>;
  /** Next confirm fails with this error code (one-shot). */
  failNextConfirm: string | null;
  confirmCalls: { ref: PrRef; headSha: string }[];
  confirmDelayMs: number;
}

export function makeFakePrApi(prs: PrChecks[]): FakePrApi {
  const api: FakePrApi = {
    prs: new Map(prs.map((p) => [p.number, p])),
    failNextConfirm: null,
    confirmCalls: [],
    confirmDelayMs: 0,
    async getChecks(ref) {
      const pr = api.prs.get(ref.number);
      if (!pr) return { ok: false, error: { status: 404, error: "pr_not_found" } };
      return { ok: true, value: { pr, confirm: eligibility(pr) } as PrChecksView };
    },
    async confirm(ref, headSha) {
      api.confirmCalls.push({ ref, headSha });
      if (api.confirmDelayMs) await new Promise((r) => setTimeout(r, api.confirmDelayMs));
      const pr = api.prs.get(ref.number);
      if (!pr) return { ok: false, error: { status: 404, error: "pr_not_found" } };
      if (api.failNextConfirm) {
        const error = api.failNextConfirm;
        api.failNextConfirm = null;
        return { ok: false, error: { status: 409, error, message: blockerText(error) } };
      }
      // prod-gate re-runs on `labeled` and turns green.
      const checks = pr.checks.map((c) => (c.labelGate ? { ...c, state: "pass" as const } : c));
      const next = makePr({ ...pr, labels: [...pr.labels, "確認した"], checks });
      api.prs.set(ref.number, next);
      return { ok: true, value: { pr: next, confirm: eligibility(next), result: "labeled" } };
    },
  };
  return api;
}
