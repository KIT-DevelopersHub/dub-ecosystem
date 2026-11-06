// PR CI status + 「確認」 (adds the `確認した` production-gate label) for the Commander board.
//
//   GET  /prs/:number/checks[?repo=owner/name][&fresh=1] -> { pr: PrChecks, confirm: ConfirmEligibility }
//   POST /prs/:number/confirm  { headSha, repo? }        -> { pr, confirm, result }
//
// Authorization of the routes is the protection table (CONFIRM is its own word there).
// This module owns the INSTANCE checks: repo allow-list, PR open / not merged, head SHA the
// operator looked at is still the head, CI policy, and the GitHub token's own permission.
// Every confirm attempt (labeled, already, refused, error) is appended to
// commander_pr_confirmations.
import type { D1Database } from "@cloudflare/workers-types";
import { newId, nowIso } from "@dub/db";
import type { Env } from "./env";
import {
  CONFIRM_LABEL,
  GitHubClient,
  GitHubError,
  confirmEligibility,
  type ChecksPolicy,
  type ConfirmEligibility,
  type PrChecks,
} from "./github";

export const DEFAULT_GITHUB_REPO = "KIT-DevelopersHub/dub-ecosystem";
/** GitHub reads are cached this long per PR (rate limit + free-plan subrequests). */
export const CHECKS_CACHE_TTL_MS = 45_000;

export interface PrConfig {
  token: string | null;
  owner: string;
  name: string;
  enabled: boolean;
  policy: ChecksPolicy;
}

export function prConfig(env: Env): PrConfig {
  const [owner = "", name = ""] = (env.COMMANDER_GITHUB_REPO || DEFAULT_GITHUB_REPO).split("/");
  const token = env.COMMANDER_GITHUB_TOKEN ? env.COMMANDER_GITHUB_TOKEN : null;
  return {
    token,
    owner,
    name,
    // The button only works when explicitly switched on AND a token exists.
    enabled: env.COMMANDER_PR_CONFIRM_ENABLED === "1" && token !== null,
    policy: env.COMMANDER_CONFIRM_CHECKS_POLICY === "warn" ? "warn" : "block",
  };
}

// Per-isolate cache. Small and short-lived; a confirm drops the PR's entry.
const cache = new Map<string, { at: number; pr: PrChecks }>();
export function clearChecksCache(): void {
  cache.clear();
}

export type PrOutcome =
  | { ok: true; status: 200; body: Record<string, unknown> }
  | { ok: false; status: number; body: { error: string; message?: string; [k: string]: unknown } };

function fail(status: number, error: string, message?: string, extra: Record<string, unknown> = {}): PrOutcome {
  return { ok: false, status, body: { error, ...(message ? { message } : {}), ...extra } };
}

function githubFailure(e: unknown): PrOutcome {
  if (e instanceof GitHubError) {
    const status = e.code === "pr_not_found" ? 404 : 502;
    return fail(status, e.code, e.message);
  }
  return fail(502, "github_unavailable", "GitHub の応答を解釈できません");
}

/** Shared request validation: number, repo allow-list, token presence. */
function resolve(
  env: Env,
  numberParam: string,
  repoParam: string | undefined,
): { ok: true; cfg: PrConfig; number: number } | { ok: false; out: PrOutcome } {
  const number = Number(numberParam);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, out: fail(400, "invalid_pr_number") };
  const cfg = prConfig(env);
  if (repoParam && repoParam.toLowerCase() !== `${cfg.owner}/${cfg.name}`.toLowerCase()) {
    return { ok: false, out: fail(400, "repo_not_allowed", `このリポジトリの PR だけを扱えます: ${cfg.owner}/${cfg.name}`) };
  }
  if (!cfg.token) {
    return { ok: false, out: fail(503, "github_not_configured", "GitHub トークンが設定されていません (COMMANDER_GITHUB_TOKEN)") };
  }
  return { ok: true, cfg, number };
}

export async function getChecks(
  env: Env,
  numberParam: string,
  opts: { repo?: string; fresh?: boolean; fetch?: typeof fetch; now?: number } = {},
): Promise<PrOutcome> {
  const r = resolve(env, numberParam, opts.repo);
  if (!r.ok) return r.out;
  const { cfg, number } = r;
  const key = `${cfg.owner}/${cfg.name}#${number}`;
  const now = opts.now ?? Date.now();
  let pr = opts.fresh ? undefined : cache.get(key);
  if (!pr || now - pr.at > CHECKS_CACHE_TTL_MS) {
    try {
      const gh = new GitHubClient({ token: cfg.token!, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
      pr = { at: now, pr: await gh.getPrChecks(cfg.owner, cfg.name, number) };
      cache.set(key, pr);
    } catch (e) {
      return githubFailure(e);
    }
  }
  return {
    ok: true,
    status: 200,
    body: {
      pr: pr.pr,
      confirm: confirmEligibility(pr.pr, { enabled: cfg.enabled, policy: cfg.policy }),
      cachedAt: new Date(pr.at).toISOString(),
    },
  };
}

const REFUSAL_STATUS: Record<string, number> = {
  confirm_disabled: 403,
  token_insufficient: 403,
  pr_merged: 409,
  pr_closed: 409,
  pr_draft: 409,
  checks_not_green: 409,
};

const REFUSAL_MESSAGE: Record<string, string> = {
  confirm_disabled: "確認ボタンは無効です (COMMANDER_PR_CONFIRM_ENABLED=1 と GitHub トークンが必要)",
  token_insufficient: "GitHub トークンにこのリポジトリへのラベル付与権限がありません",
  pr_merged: "マージ済みの PR には付けられません",
  pr_closed: "クローズ済みの PR には付けられません",
  pr_draft: "Draft の PR には付けられません",
  checks_not_green: "必須の CI が通過していません",
};

async function audit(
  db: D1Database,
  row: {
    repo: string;
    number: number;
    headSha: string | null;
    login: string | null;
    result: "labeled" | "already_confirmed" | "refused" | "error";
    reason: string | null;
    pr: PrChecks | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO commander_pr_confirmations
         (id, repo, pr_number, head_sha, label, github_login, result, reason, checks_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("cprc"),
      row.repo,
      row.number,
      row.headSha,
      CONFIRM_LABEL,
      row.login,
      row.result,
      row.reason,
      row.pr ? JSON.stringify(row.pr.summary) : null,
      nowIso(),
    )
    .run();
}

export async function confirmPr(
  env: Env,
  numberParam: string,
  body: unknown,
  opts: { fetch?: typeof fetch } = {},
): Promise<PrOutcome> {
  const b = (body ?? {}) as { headSha?: unknown; repo?: unknown };
  const headSha = typeof b.headSha === "string" && /^[0-9a-f]{7,40}$/i.test(b.headSha) ? b.headSha : null;
  if (!headSha) return fail(400, "head_sha_required", "確認した commit (headSha) を指定してください");
  const r = resolve(env, numberParam, typeof b.repo === "string" ? b.repo : undefined);
  if (!r.ok) return r.out;
  const { cfg, number } = r;
  const repo = `${cfg.owner}/${cfg.name}`;
  const base = { repo, number, headSha };

  // Always decide on a FRESH read: the cache may predate a merge or a new push.
  const gh = new GitHubClient({ token: cfg.token!, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  let pr: PrChecks;
  try {
    pr = await gh.getPrChecks(cfg.owner, cfg.name, number);
  } catch (e) {
    const out = githubFailure(e);
    await audit(env.DB, { ...base, login: null, result: "error", reason: String(out.body.error), pr: null });
    return out;
  }
  cache.set(`${repo}#${number}`, { at: Date.now(), pr });
  const login = pr.viewerLogin;

  const elig: ConfirmEligibility = confirmEligibility(pr, { enabled: cfg.enabled, policy: cfg.policy });
  if (elig.reason === "already_confirmed") {
    await audit(env.DB, { ...base, login, result: "already_confirmed", reason: null, pr });
    return { ok: true, status: 200, body: { result: "already_confirmed", pr, confirm: elig } };
  }
  if (!elig.allowed) {
    const reason = elig.reason!;
    await audit(env.DB, { ...base, login, result: "refused", reason, pr });
    return fail(REFUSAL_STATUS[reason] ?? 409, reason, REFUSAL_MESSAGE[reason], { pr, confirm: elig });
  }
  // The operator approved what they saw. A push since then is a different build.
  if (!pr.headSha.toLowerCase().startsWith(headSha.toLowerCase())) {
    await audit(env.DB, { ...base, login, result: "refused", reason: "head_moved", pr });
    return fail(409, "head_moved", "確認後に PR へ新しい commit が push されました。表示を更新して確かめ直してください", {
      pr,
      confirm: elig,
    });
  }

  try {
    await gh.addLabel(cfg.owner, cfg.name, number, CONFIRM_LABEL);
  } catch (e) {
    const out = githubFailure(e);
    const reason = String(out.body.error);
    await audit(env.DB, { ...base, login, result: "error", reason, pr });
    if (reason === "github_forbidden" || reason === "github_unauthorized") {
      return fail(403, "token_insufficient", "GitHub トークンでラベルを付けられませんでした (権限不足)");
    }
    return out;
  }

  const labeled: PrChecks = { ...pr, labels: [...pr.labels, CONFIRM_LABEL], confirmed: true };
  cache.set(`${repo}#${number}`, { at: Date.now(), pr: labeled });
  await audit(env.DB, { ...base, headSha: pr.headSha, login, result: "labeled", reason: null, pr });
  return {
    ok: true,
    status: 200,
    body: {
      result: "labeled",
      pr: labeled,
      confirm: confirmEligibility(labeled, { enabled: cfg.enabled, policy: cfg.policy }),
      warnings: elig.warnings,
    },
  };
}
