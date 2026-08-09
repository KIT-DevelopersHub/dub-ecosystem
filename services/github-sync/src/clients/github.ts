// GitHub API port. The engine depends only on `GithubApiClient`; two adapters
// implement it: `RealGithubApi` (GitHub App installation auth + REST v3, shipped
// in production when the App secret is present) and `StubGithubApi` (fail-closed,
// used until the App is configured and injected in unit tests via a mock fetch).
import { DubError } from "@dub/errors";
import type { IssueSnapshot } from "../domain/types";

export interface CreateIssueInput {
  owner: string;
  repo: string;
  title: string;
  body: string | null;
  labels: string[];
  assignees: string[];
}

export interface UpdateIssueInput {
  owner: string;
  repo: string;
  number: number;
  title?: string;
  body?: string | null;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
}

export interface GithubApiClient {
  getIssue(owner: string, repo: string, number: number): Promise<IssueSnapshot | null>;
  createIssue(input: CreateIssueInput): Promise<IssueSnapshot>;
  updateIssue(input: UpdateIssueInput): Promise<IssueSnapshot>;
  addComment(owner: string, repo: string, number: number, body: string): Promise<void>;
  // Reconciliation: issues updated since `sinceIso` (null = full).
  listIssues(owner: string, repo: string, sinceIso: string | null): Promise<IssueSnapshot[]>;
}

// Fail-closed stub used when the GitHub App secret is not configured.
export class StubGithubApi implements GithubApiClient {
  private fail(op: string): never {
    throw new DubError("GITHUB_NOT_CONFIGURED", `GitHub API not wired yet (${op}); set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY`, {
      status: 502,
      retryable: false,
    });
  }
  getIssue(): Promise<IssueSnapshot | null> {
    return this.fail("getIssue");
  }
  createIssue(): Promise<IssueSnapshot> {
    return this.fail("createIssue");
  }
  updateIssue(): Promise<IssueSnapshot> {
    return this.fail("updateIssue");
  }
  addComment(): Promise<void> {
    return this.fail("addComment");
  }
  listIssues(): Promise<IssueSnapshot[]> {
    return this.fail("listIssues");
  }
}

// ---------------------------------------------------------------------------
// Real GitHub App REST v3 client.
// ---------------------------------------------------------------------------

export interface GithubAppAuth {
  appId: string;
  // PEM private key (PKCS#8 "BEGIN PRIVATE KEY" or PKCS#1 "BEGIN RSA PRIVATE KEY").
  privateKeyPem: string;
}

export interface RealGithubApiOptions {
  auth: GithubAppAuth;
  fetch?: typeof fetch; // injectable for tests; defaults to global fetch
  baseUrl?: string; // default https://api.github.com
  userAgent?: string; // default dub-github-sync
  now?: () => number; // epoch ms, for JWT/token expiry (default Date.now)
}

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_USER_AGENT = "dub-github-sync";
const API_VERSION = "2022-11-28";
const JWT_TTL_SEC = 540; // 9 min (< GitHub's 10 min ceiling)
const TOKEN_SKEW_MS = 60_000; // refresh installation token 60s before expiry
const PER_PAGE = 100;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

// Minimal shape of the GitHub issue payload we read.
interface GithubIssuePayload {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<string | { name?: string | null }>;
  assignees: Array<{ login: string }> | null;
  updated_at: string;
  pull_request?: unknown; // present when the "issue" is actually a PR
}

export class RealGithubApi implements GithubApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly auth: GithubAppAuth;

  private signingKey: Promise<CryptoKey> | null = null;
  private readonly installationIdByRepo = new Map<string, number>();
  private readonly tokenByInstallation = new Map<number, CachedToken>();

  constructor(opts: RealGithubApiOptions) {
    this.auth = opts.auth;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.now = opts.now ?? Date.now;
  }

  async getIssue(owner: string, repo: string, number: number): Promise<IssueSnapshot | null> {
    const res = await this.installationRequest(owner, repo, "GET", `/repos/${enc(owner)}/${enc(repo)}/issues/${number}`);
    if (res.status === 404) {
      await res.text().catch(() => undefined); // drain body
      return null;
    }
    const payload = await this.readJson<GithubIssuePayload>(res, "getIssue");
    return toSnapshot(owner, repo, payload);
  }

  async createIssue(input: CreateIssueInput): Promise<IssueSnapshot> {
    const res = await this.installationRequest(
      input.owner,
      input.repo,
      "POST",
      `/repos/${enc(input.owner)}/${enc(input.repo)}/issues`,
      { title: input.title, body: input.body, labels: input.labels, assignees: input.assignees },
    );
    const payload = await this.readJson<GithubIssuePayload>(res, "createIssue");
    return toSnapshot(input.owner, input.repo, payload);
  }

  async updateIssue(input: UpdateIssueInput): Promise<IssueSnapshot> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.body !== undefined) body.body = input.body;
    if (input.state !== undefined) body.state = input.state;
    if (input.labels !== undefined) body.labels = input.labels;
    if (input.assignees !== undefined) body.assignees = input.assignees;
    const res = await this.installationRequest(
      input.owner,
      input.repo,
      "PATCH",
      `/repos/${enc(input.owner)}/${enc(input.repo)}/issues/${input.number}`,
      body,
    );
    const payload = await this.readJson<GithubIssuePayload>(res, "updateIssue");
    return toSnapshot(input.owner, input.repo, payload);
  }

  async addComment(owner: string, repo: string, number: number, body: string): Promise<void> {
    const res = await this.installationRequest(
      owner,
      repo,
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/issues/${number}/comments`,
      { body },
    );
    // Success is 201; drain body and enforce 2xx.
    if (!res.ok) throw await this.mapError("addComment", res);
    await res.text().catch(() => undefined);
  }

  async listIssues(owner: string, repo: string, sinceIso: string | null): Promise<IssueSnapshot[]> {
    const out: IssueSnapshot[] = [];
    let page = 1;
    // Page until a short page is returned. state=all so closed issues reconcile too.
    for (;;) {
      const params = new URLSearchParams({
        state: "all",
        per_page: String(PER_PAGE),
        page: String(page),
        sort: "updated",
        direction: "asc",
      });
      if (sinceIso) params.set("since", sinceIso);
      const res = await this.installationRequest(
        owner,
        repo,
        "GET",
        `/repos/${enc(owner)}/${enc(repo)}/issues?${params.toString()}`,
      );
      const payloads = await this.readJson<GithubIssuePayload[]>(res, "listIssues");
      for (const p of payloads) {
        // The issues endpoint also returns pull requests; skip them.
        if (p.pull_request) continue;
        out.push(toSnapshot(owner, repo, p));
      }
      if (payloads.length < PER_PAGE) break;
      page += 1;
    }
    return out;
  }

  // --- auth / transport ----------------------------------------------------

  private async installationRequest(
    owner: string,
    repo: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const token = await this.installationToken(owner, repo);
    return this.request(method, path, `token ${token}`, body);
  }

  private async request(method: string, path: string, authorization: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization,
      "user-agent": this.userAgent,
      "x-github-api-version": API_VERSION,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      throw new DubError("GITHUB_UNAVAILABLE", "GitHub request failed to reach upstream", {
        status: 502,
        retryable: true,
        service: "github",
        cause,
      });
    }
    return res;
  }

  private async installationToken(owner: string, repo: string): Promise<string> {
    const installationId = await this.installationId(owner, repo);
    const cached = this.tokenByInstallation.get(installationId);
    if (cached && cached.expiresAtMs - TOKEN_SKEW_MS > this.now()) return cached.token;

    const jwt = await this.appJwt();
    const res = await this.request("POST", `/app/installations/${installationId}/access_tokens`, `Bearer ${jwt}`);
    const payload = await this.readJson<{ token: string; expires_at: string }>(res, "createInstallationToken");
    const expiresAtMs = Date.parse(payload.expires_at);
    this.tokenByInstallation.set(installationId, {
      token: payload.token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.now() + 3_600_000,
    });
    return payload.token;
  }

  private async installationId(owner: string, repo: string): Promise<number> {
    const key = `${owner}/${repo}`;
    const cached = this.installationIdByRepo.get(key);
    if (cached !== undefined) return cached;

    const jwt = await this.appJwt();
    const res = await this.request("GET", `/repos/${enc(owner)}/${enc(repo)}/installation`, `Bearer ${jwt}`);
    const payload = await this.readJson<{ id: number }>(res, "getInstallation");
    if (typeof payload.id !== "number") {
      throw new DubError("GITHUB_UNEXPECTED_RESPONSE", "installation lookup returned no id", {
        status: 502,
        retryable: false,
        service: "github",
      });
    }
    this.installationIdByRepo.set(key, payload.id);
    return payload.id;
  }

  private async appJwt(): Promise<string> {
    const key = await this.getSigningKey();
    const nowSec = Math.floor(this.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = { iat: nowSec - 30, exp: nowSec + JWT_TTL_SEC, iss: this.auth.appId };
    const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${b64url(new Uint8Array(sig))}`;
  }

  private getSigningKey(): Promise<CryptoKey> {
    if (!this.signingKey) {
      this.signingKey = importRsaPrivateKey(this.auth.privateKeyPem).catch((cause) => {
        // reset so a later call can retry with corrected config; never leak the key
        this.signingKey = null;
        throw new DubError("GITHUB_APP_KEY_INVALID", "failed to import GitHub App private key", {
          status: 500,
          retryable: false,
          service: "github",
          cause,
        });
      });
    }
    return this.signingKey;
  }

  private async readJson<T>(res: Response, op: string): Promise<T> {
    if (!res.ok) throw await this.mapError(op, res);
    try {
      return (await res.json()) as T;
    } catch (cause) {
      throw new DubError("GITHUB_UNEXPECTED_RESPONSE", `${op}: response was not valid JSON`, {
        status: 502,
        retryable: true,
        service: "github",
        cause,
      });
    }
  }

  // Map a non-2xx GitHub response to a DubError. Never includes secrets; reads
  // only the response status/headers and GitHub's own error message.
  private async mapError(op: string, res: Response): Promise<DubError> {
    const detail = await readErrorMessage(res);
    const suffix = detail ? `: ${detail}` : "";
    const status = res.status;

    // Secondary/primary rate limit → retryable.
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (status === 429 || (status === 403 && remaining === "0")) {
      const retryAfter = Number(res.headers.get("retry-after"));
      return new DubError("GITHUB_RATE_LIMITED", `${op}: GitHub rate limit${suffix}`, {
        status: 429,
        retryable: true,
        service: "github",
        details: Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSec: retryAfter } : undefined,
      });
    }
    if (status === 401) {
      return new DubError("GITHUB_UNAUTHORIZED", `${op}: GitHub rejected credentials${suffix}`, {
        status: 502,
        retryable: false,
        service: "github",
      });
    }
    if (status === 403) {
      return new DubError("GITHUB_FORBIDDEN", `${op}: GitHub forbade the request${suffix}`, {
        status: 502,
        retryable: false,
        service: "github",
      });
    }
    if (status === 404) {
      return new DubError("GITHUB_NOT_FOUND", `${op}: GitHub resource not found${suffix}`, {
        status: 404,
        retryable: false,
        service: "github",
      });
    }
    if (status === 410) {
      return new DubError("GITHUB_GONE", `${op}: GitHub resource gone${suffix}`, {
        status: 404,
        retryable: false,
        service: "github",
      });
    }
    if (status === 422) {
      return new DubError("GITHUB_UNPROCESSABLE", `${op}: GitHub rejected the payload${suffix}`, {
        status: 422,
        retryable: false,
        service: "github",
      });
    }
    if (status >= 500) {
      return new DubError("GITHUB_UNAVAILABLE", `${op}: GitHub server error (${status})${suffix}`, {
        status: 502,
        retryable: true,
        service: "github",
      });
    }
    return new DubError("GITHUB_REQUEST_FAILED", `${op}: GitHub returned ${status}${suffix}`, {
      status: 502,
      retryable: false,
      service: "github",
    });
  }
}

// --- helpers ---------------------------------------------------------------

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function toSnapshot(owner: string, repo: string, p: GithubIssuePayload): IssueSnapshot {
  return {
    owner,
    repo,
    number: p.number,
    nodeId: p.node_id,
    title: p.title,
    body: p.body ?? null,
    state: p.state === "closed" ? "closed" : "open",
    labels: (p.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l?.name ?? null))
      .filter((n): n is string => typeof n === "string" && n.length > 0),
    assignees: (p.assignees ?? []).map((a) => a.login).filter((l) => typeof l === "string" && l.length > 0),
    updatedAt: p.updated_at,
  };
}

// Best-effort extraction of GitHub's error message; tolerant of non-JSON bodies.
async function readErrorMessage(res: Response): Promise<string | null> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
  } catch {
    // not JSON; fall through to truncated raw text
  }
  return text.slice(0, 200);
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}

// GitHub App private keys download as PKCS#1 ("BEGIN RSA PRIVATE KEY"), but
// WebCrypto only imports PKCS#8. Wrap PKCS#1 DER in a PKCS#8 PrivateKeyInfo.
async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const der = pemToDer(pem);
  const pkcs8 = isPkcs1 ? wrapPkcs1AsPkcs8(der) : der;
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// DER length octets for a given content length.
function derLength(len: number): number[] {
  if (len < 0x80) return [len];
  const bytes: number[] = [];
  let v = len;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return [0x80 | bytes.length, ...bytes];
}

// Wrap a PKCS#1 RSAPrivateKey DER into a PKCS#8 PrivateKeyInfo:
//   SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING <pkcs1> }
function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octetString = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const inner = [...version, ...algId, ...octetString];
  const seq = [0x30, ...derLength(inner.length), ...inner];
  return new Uint8Array(seq);
}
