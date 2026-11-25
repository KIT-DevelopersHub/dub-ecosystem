// GitHub access for the PR CI badge + 「確認」 button.
//
// One GraphQL call reads everything the board shows for a PR (state, head SHA, labels,
// mergeStateStatus, the statusCheckRollup of the head commit, and the token's own
// permission on the repo), so a board refresh costs one subrequest per PR — well inside
// the Workers free plan's 50-per-invocation cap. Adding the label is one REST call.
//
// Pure parts (normalizeChecks / summarize / confirmBlocker) are exported separately so the
// decision logic is unit-tested without a network.

/** The production gate label. Adding it turns prod-gate.yml's `confirm-gate` green. */
export const CONFIRM_LABEL = "確認した";
/** Labels that put a PR on a staging slot (staging.yml). */
export const STAGING_LABELS = ["stagingへ", "staging2へ"] as const;
/**
 * prod-gate.yml's check. It is red EXACTLY because 確認した is missing, so it is shown as
 * the label gate, never counted as a CI result (a "4/5" that is always 4/5 until the
 * button is pressed would make the button look blocked by itself).
 */
export const LABEL_GATE_CHECK = "confirm-gate";

export type CheckState = "pass" | "fail" | "pending" | "skipped";

export interface NormalizedCheck {
  name: string;
  state: CheckState;
  url: string | null;
  /** Required by branch protection on the PR's base (null when GitHub did not say). */
  required: boolean | null;
  /** True for prod-gate's confirm-gate (excluded from the CI counts). */
  labelGate: boolean;
}

export interface ChecksSummary {
  /** Overall CI verdict, label gate excluded. `none` = no checks reported at all. */
  state: "pass" | "fail" | "pending" | "none";
  passed: number;
  /** Counted checks (skipped and the label gate excluded). */
  total: number;
  pending: number;
  failing: string[];
  /** Required checks (label gate excluded) that are failing or still running. */
  requiredNotPassing: string[];
}

export type PrState = "OPEN" | "CLOSED" | "MERGED";

export interface PrChecks {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  headSha: string;
  mergeStateStatus: string | null;
  labels: string[];
  confirmed: boolean;
  staging: { stagingへ: boolean; staging2へ: boolean };
  checks: NormalizedCheck[];
  summary: ChecksSummary;
  /** The token's permission on the repo (ADMIN/MAINTAIN/WRITE/TRIAGE/READ) or null. */
  viewerPermission: string | null;
  /** GitHub login the label will be attributed to. */
  viewerLogin: string | null;
}

export type ChecksPolicy = "block" | "warn";

export interface ConfirmEligibility {
  allowed: boolean;
  /** Machine reason when not allowed (or when allowed with a warning). */
  reason: ConfirmBlocker | null;
  /** Non-blocking warnings (e.g. checks failing under the `warn` policy). */
  warnings: string[];
}

export type ConfirmBlocker =
  | "confirm_disabled"
  | "pr_merged"
  | "pr_closed"
  | "pr_draft"
  | "already_confirmed"
  | "token_insufficient"
  | "checks_not_green";

// ── normalization ───────────────────────────────────────────────────────────────────────

/** Raw node shapes from the GraphQL statusCheckRollup (`__typename` discriminated). */
export type RawCheckNode =
  | {
      __typename: "CheckRun";
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      isRequired?: boolean | null;
      checkSuite?: { workflowRun?: { workflow?: { name?: string | null } | null } | null } | null;
    }
  | {
      __typename: "StatusContext";
      context: string;
      state: string;
      targetUrl: string | null;
      isRequired?: boolean | null;
    };

function checkRunState(status: string, conclusion: string | null): CheckState {
  if (status !== "COMPLETED") return "pending";
  switch (conclusion) {
    case "SUCCESS":
      return "pass";
    case "NEUTRAL":
    case "SKIPPED":
      return "skipped";
    default:
      // FAILURE / TIMED_OUT / CANCELLED / ACTION_REQUIRED / STARTUP_FAILURE / STALE / null
      return "fail";
  }
}

function statusContextState(state: string): CheckState {
  if (state === "SUCCESS") return "pass";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return "fail"; // FAILURE / ERROR
}

/** Raw rollup nodes -> display rows, sorted fail > pending > pass > skipped, then name. */
export function normalizeChecks(nodes: readonly (RawCheckNode | null)[]): NormalizedCheck[] {
  const out: NormalizedCheck[] = [];
  for (const n of nodes) {
    if (!n) continue;
    if (n.__typename === "CheckRun") {
      out.push({
        name: n.name,
        state: checkRunState(n.status, n.conclusion),
        url: n.detailsUrl ?? null,
        required: typeof n.isRequired === "boolean" ? n.isRequired : null,
        labelGate: n.name === LABEL_GATE_CHECK,
      });
    } else if (n.__typename === "StatusContext") {
      out.push({
        name: n.context,
        state: statusContextState(n.state),
        url: n.targetUrl ?? null,
        required: typeof n.isRequired === "boolean" ? n.isRequired : null,
        labelGate: n.context === LABEL_GATE_CHECK,
      });
    }
  }
  const rank: Record<CheckState, number> = { fail: 0, pending: 1, pass: 2, skipped: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

export function summarize(checks: readonly NormalizedCheck[]): ChecksSummary {
  const counted = checks.filter((c) => !c.labelGate && c.state !== "skipped");
  const passed = counted.filter((c) => c.state === "pass").length;
  const pending = counted.filter((c) => c.state === "pending").length;
  const failing = counted.filter((c) => c.state === "fail").map((c) => c.name);
  // When branch protection marks nothing as required (or GitHub did not say), every counted
  // check is treated as required: refusing on an unknown is the safe reading of a prod gate.
  const anyRequired = counted.some((c) => c.required === true);
  const requiredNotPassing = counted
    .filter((c) => (anyRequired ? c.required === true : true))
    .filter((c) => c.state !== "pass")
    .map((c) => c.name);
  const state: ChecksSummary["state"] =
    counted.length === 0 ? "none" : failing.length > 0 ? "fail" : pending > 0 ? "pending" : "pass";
  return { state, passed, total: counted.length, pending, failing, requiredNotPassing };
}

const LABEL_WRITE_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE"]);

/**
 * Whether 「確認」 may be pressed now, decided server-side (the UI only mirrors it).
 * Order matters: the first blocker is the one the operator is told about.
 */
export function confirmEligibility(
  pr: Pick<PrChecks, "state" | "isDraft" | "confirmed" | "viewerPermission" | "summary">,
  opts: { enabled: boolean; policy: ChecksPolicy },
): ConfirmEligibility {
  const block = (reason: ConfirmBlocker): ConfirmEligibility => ({ allowed: false, reason, warnings: [] });
  if (!opts.enabled) return block("confirm_disabled");
  if (pr.state === "MERGED") return block("pr_merged");
  if (pr.state === "CLOSED") return block("pr_closed");
  if (pr.confirmed) return block("already_confirmed");
  if (pr.isDraft) return block("pr_draft");
  if (!pr.viewerPermission || !LABEL_WRITE_PERMISSIONS.has(pr.viewerPermission)) {
    return block("token_insufficient");
  }
  const notGreen = pr.summary.requiredNotPassing;
  if (notGreen.length > 0) {
    if (opts.policy === "block") return block("checks_not_green");
    return { allowed: true, reason: null, warnings: [`未通過のチェック: ${notGreen.join(", ")}`] };
  }
  return { allowed: true, reason: null, warnings: [] };
}

// ── client ──────────────────────────────────────────────────────────────────────────────

export class GitHubError extends Error {
  constructor(
    readonly code: "github_unauthorized" | "github_forbidden" | "pr_not_found" | "github_unavailable",
    message: string,
  ) {
    super(message);
  }
}

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$name){
    viewerPermission
    pullRequest(number:$number){
      number title url state isDraft mergeStateStatus headRefOid
      labels(first:50){nodes{name}}
      commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){nodes{
        __typename
        ... on CheckRun{name status conclusion detailsUrl isRequired(pullRequestNumber:$number)}
        ... on StatusContext{context state targetUrl isRequired(pullRequestNumber:$number)}
      }}}}}}
    }
  }
}`;

interface PrQueryData {
  viewer?: { login?: string } | null;
  repository?: {
    viewerPermission?: string | null;
    pullRequest?: {
      number: number;
      title: string;
      url: string;
      state: PrState;
      isDraft: boolean;
      mergeStateStatus?: string | null;
      headRefOid: string;
      labels?: { nodes?: ({ name: string } | null)[] } | null;
      commits?: {
        nodes?: ({
          commit?: { statusCheckRollup?: { contexts?: { nodes?: (RawCheckNode | null)[] } | null } | null };
        } | null)[];
      } | null;
    } | null;
  } | null;
}

export interface GitHubClientOptions {
  token: string;
  fetch?: typeof fetch;
  apiBase?: string;
}

const UA = "dub-commander-service";

/** Thin GitHub client. Never logs or echoes the token. */
export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly opts: GitHubClientOptions) {
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.apiBase = opts.apiBase ?? "https://api.github.com";
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": UA,
      "x-github-api-version": "2022-11-28",
    };
  }

  private static statusError(status: number, what: string): GitHubError {
    if (status === 401) return new GitHubError("github_unauthorized", `${what}: GitHub トークンが無効です`);
    if (status === 403) return new GitHubError("github_forbidden", `${what}: GitHub トークンに権限がありません`);
    if (status === 404) return new GitHubError("pr_not_found", `${what}: PR が見つかりません`);
    return new GitHubError("github_unavailable", `${what}: GitHub が ${status} を返しました`);
  }

  async getPrChecks(owner: string, name: string, number: number): Promise<PrChecks> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}/graphql`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ query: PR_QUERY, variables: { owner, name, number } }),
      });
    } catch {
      throw new GitHubError("github_unavailable", "GitHub に接続できません");
    }
    if (!res.ok) throw GitHubClient.statusError(res.status, "PR の取得");
    const body = (await res.json().catch(() => null)) as { data?: PrQueryData; errors?: { type?: string; message?: string }[] } | null;
    const data = body?.data;
    const pr = data?.repository?.pullRequest;
    if (!pr) {
      const forbidden = body?.errors?.some((e) => e.type === "FORBIDDEN" || e.type === "INSUFFICIENT_SCOPES");
      if (forbidden) throw new GitHubError("github_forbidden", "PR の取得: GitHub トークンに権限がありません");
      throw new GitHubError("pr_not_found", "PR が見つかりません");
    }
    const labels = (pr.labels?.nodes ?? []).flatMap((l) => (l ? [l.name] : []));
    const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    const checks = normalizeChecks(nodes);
    return {
      repo: `${owner}/${name}`,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      headSha: pr.headRefOid,
      mergeStateStatus: pr.mergeStateStatus ?? null,
      labels,
      confirmed: labels.includes(CONFIRM_LABEL),
      staging: { stagingへ: labels.includes("stagingへ"), staging2へ: labels.includes("staging2へ") },
      checks,
      summary: summarize(checks),
      viewerPermission: data?.repository?.viewerPermission ?? null,
      viewerLogin: data?.viewer?.login ?? null,
    };
  }

  /** POST /repos/{o}/{r}/issues/{n}/labels — additive (never removes other labels). */
  async addLabel(owner: string, name: string, number: number, label: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}/repos/${owner}/${name}/issues/${number}/labels`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ labels: [label] }),
      });
    } catch {
      throw new GitHubError("github_unavailable", "GitHub に接続できません");
    }
    if (!res.ok) throw GitHubClient.statusError(res.status, "ラベル付与");
  }
}
