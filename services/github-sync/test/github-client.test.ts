// Unit tests for the real GitHub App REST client. Everything is driven through
// an injected fetch: the client mints a real RS256 App JWT (with a locally
// generated key), exchanges it for an installation token, then issues REST v3
// calls. No network and no secrets are touched.
import { describe, it, expect, beforeAll } from "vitest";
import { DubError } from "@dub/errors";
import { RealGithubApi } from "../src/clients/github";

// --- fixtures --------------------------------------------------------------

let privateKeyPem: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let binary = "";
  for (const b of pkcs8) binary += String.fromCharCode(b);
  const b64 = btoa(binary).replace(/(.{64})/g, "$1\n");
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
});

interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const issuePayload = (over: Record<string, unknown> = {}) => ({
  number: 5,
  node_id: "I_node5",
  title: "Issue title",
  body: "Issue body",
  state: "open",
  labels: [{ name: "bug" }, { name: "status:in_progress" }],
  assignees: [{ login: "octocat" }],
  updated_at: "2026-08-09T06:00:00Z",
  ...over,
});

// A routing mock fetch. `routes` maps "METHOD /path" (path only, no query) to a
// handler returning a Response. Installation lookup + token exchange are wired by
// default; individual tests override the operation endpoint.
function makeFetch(routes: Record<string, (call: RecordedCall) => Response>) {
  const calls: RecordedCall[] = [];
  const defaults: Record<string, (call: RecordedCall) => Response> = {
    "GET /repos/acme/web/installation": () => jsonResponse(200, { id: 42 }),
    "POST /app/installations/42/access_tokens": () =>
      jsonResponse(201, { token: "ghs_installtoken", expires_at: "2999-01-01T00:00:00Z" }),
  };
  const table = { ...defaults, ...routes };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    const call: RecordedCall = {
      method,
      url,
      authorization: headers.get("authorization"),
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody ?? null,
    };
    calls.push(call);
    const handler = table[`${method} ${u.pathname}`];
    if (!handler) throw new Error(`unexpected request: ${method} ${u.pathname}`);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(routes: Record<string, (call: RecordedCall) => Response>) {
  const { fetchImpl, calls } = makeFetch(routes);
  const client = new RealGithubApi({
    auth: { appId: "123456", privateKeyPem },
    fetch: fetchImpl,
    baseUrl: "https://api.github.com",
  });
  return { client, calls };
}

// --- tests -----------------------------------------------------------------

describe("RealGithubApi auth flow", () => {
  it("mints an App JWT, exchanges it for an installation token, and authorizes ops with it", async () => {
    const { client, calls } = makeClient({
      "GET /repos/acme/web/issues/5": () => jsonResponse(200, issuePayload()),
    });
    const snap = await client.getIssue("acme", "web", 5);
    expect(snap).not.toBeNull();

    const instCall = calls.find((c) => c.url.endsWith("/repos/acme/web/installation"))!;
    expect(instCall.authorization).toMatch(/^Bearer .+\..+\..+$/); // JWT
    const tokenCall = calls.find((c) => c.url.endsWith("/access_tokens"))!;
    expect(tokenCall.authorization).toMatch(/^Bearer /);
    const issueCall = calls.find((c) => c.url.includes("/issues/5"))!;
    expect(issueCall.authorization).toBe("token ghs_installtoken");
  });

  it("caches the installation id and token across calls", async () => {
    const { client, calls } = makeClient({
      "GET /repos/acme/web/issues/5": () => jsonResponse(200, issuePayload()),
    });
    await client.getIssue("acme", "web", 5);
    await client.getIssue("acme", "web", 5);
    expect(calls.filter((c) => c.url.endsWith("/installation")).length).toBe(1);
    expect(calls.filter((c) => c.url.endsWith("/access_tokens")).length).toBe(1);
    expect(calls.filter((c) => c.url.includes("/issues/5")).length).toBe(2);
  });
});

describe("RealGithubApi.getIssue", () => {
  it("maps a 200 issue payload to an IssueSnapshot", async () => {
    const { client } = makeClient({
      "GET /repos/acme/web/issues/5": () => jsonResponse(200, issuePayload()),
    });
    const snap = await client.getIssue("acme", "web", 5);
    expect(snap).toEqual({
      owner: "acme",
      repo: "web",
      number: 5,
      nodeId: "I_node5",
      title: "Issue title",
      body: "Issue body",
      state: "open",
      labels: ["bug", "status:in_progress"],
      assignees: ["octocat"],
      updatedAt: "2026-08-09T06:00:00Z",
    });
  });

  it("returns null on 404", async () => {
    const { client } = makeClient({
      "GET /repos/acme/web/issues/5": () => jsonResponse(404, { message: "Not Found" }),
    });
    expect(await client.getIssue("acme", "web", 5)).toBeNull();
  });

  it("accepts string labels and null body/assignees", async () => {
    const { client } = makeClient({
      "GET /repos/acme/web/issues/5": () =>
        jsonResponse(200, issuePayload({ body: null, labels: ["a", { name: "b" }], assignees: null })),
    });
    const snap = await client.getIssue("acme", "web", 5);
    expect(snap!.body).toBeNull();
    expect(snap!.labels).toEqual(["a", "b"]);
    expect(snap!.assignees).toEqual([]);
  });
});

describe("RealGithubApi write ops", () => {
  it("createIssue POSTs title/body/labels/assignees and returns the snapshot", async () => {
    const { client, calls } = makeClient({
      "POST /repos/acme/web/issues": () => jsonResponse(201, issuePayload({ number: 9, node_id: "I_node9" })),
    });
    const snap = await client.createIssue({
      owner: "acme",
      repo: "web",
      title: "New",
      body: "Body",
      labels: ["bug"],
      assignees: ["octocat"],
    });
    expect(snap.number).toBe(9);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues"))!;
    expect(post.body).toEqual({ title: "New", body: "Body", labels: ["bug"], assignees: ["octocat"] });
  });

  it("updateIssue PATCHes only the provided fields", async () => {
    const { client, calls } = makeClient({
      "PATCH /repos/acme/web/issues/5": () => jsonResponse(200, issuePayload({ state: "closed" })),
    });
    const snap = await client.updateIssue({ owner: "acme", repo: "web", number: 5, state: "closed" });
    expect(snap.state).toBe("closed");
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ state: "closed" });
  });

  it("updateIssue sends body:null when explicitly clearing the body", async () => {
    const { client, calls } = makeClient({
      "PATCH /repos/acme/web/issues/5": () => jsonResponse(200, issuePayload({ body: null })),
    });
    await client.updateIssue({ owner: "acme", repo: "web", number: 5, body: null });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ body: null });
  });

  it("addComment POSTs the body and resolves void on 201", async () => {
    const { client, calls } = makeClient({
      "POST /repos/acme/web/issues/5/comments": () => jsonResponse(201, { id: 1 }),
    });
    await expect(client.addComment("acme", "web", 5, "hi")).resolves.toBeUndefined();
    const post = calls.find((c) => c.url.endsWith("/comments"))!;
    expect(post.body).toEqual({ body: "hi" });
  });
});

describe("RealGithubApi.listIssues", () => {
  it("paginates until a short page and filters out pull requests", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => issuePayload({ number: i + 1, node_id: `I_${i + 1}` }));
    // inject a PR into page 1 (has pull_request key) — must be skipped
    firstPage[0] = issuePayload({ number: 1, node_id: "PR_1", pull_request: { url: "x" } });
    const secondPage = [issuePayload({ number: 200, node_id: "I_200" })];
    const { client, calls } = makeClient({
      "GET /repos/acme/web/issues": (call) => {
        const page = new URL(call.url).searchParams.get("page");
        return jsonResponse(200, page === "1" ? firstPage : secondPage);
      },
    });
    const issues = await client.listIssues("acme", "web", null);
    expect(issues.length).toBe(100); // 100 + 1 - 1 PR skipped
    expect(issues.find((i) => i.nodeId === "PR_1")).toBeUndefined();
    expect(calls.filter((c) => c.url.includes("/issues?")).length).toBe(2);
  });

  it("passes the since parameter when provided", async () => {
    const { client, calls } = makeClient({
      "GET /repos/acme/web/issues": () => jsonResponse(200, []),
    });
    await client.listIssues("acme", "web", "2026-08-01T00:00:00Z");
    const listCall = calls.find((c) => c.url.includes("/issues?"))!;
    expect(new URL(listCall.url).searchParams.get("since")).toBe("2026-08-01T00:00:00Z");
    expect(new URL(listCall.url).searchParams.get("state")).toBe("all");
  });
});

describe("RealGithubApi error mapping", () => {
  it("maps 422 to a non-retryable GITHUB_UNPROCESSABLE DubError", async () => {
    const { client } = makeClient({
      "POST /repos/acme/web/issues": () => jsonResponse(422, { message: "Validation Failed" }),
    });
    const err = await client
      .createIssue({ owner: "acme", repo: "web", title: "x", body: null, labels: [], assignees: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DubError);
    expect(err.code).toBe("GITHUB_UNPROCESSABLE");
    expect(err.status).toBe(422);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("Validation Failed");
  });

  it("maps a 403 with x-ratelimit-remaining:0 to a retryable GITHUB_RATE_LIMITED", async () => {
    const { client } = makeClient({
      "GET /repos/acme/web/issues/5": () =>
        jsonResponse(403, { message: "rate limit" }, { "x-ratelimit-remaining": "0", "retry-after": "30" }),
    });
    const err = await client.getIssue("acme", "web", 5).catch((e) => e);
    expect(err).toBeInstanceOf(DubError);
    expect(err.code).toBe("GITHUB_RATE_LIMITED");
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ retryAfterSec: 30 });
  });

  it("maps 5xx to a retryable GITHUB_UNAVAILABLE", async () => {
    const { client } = makeClient({
      "PATCH /repos/acme/web/issues/5": () => jsonResponse(503, { message: "down" }),
    });
    const err = await client.updateIssue({ owner: "acme", repo: "web", number: 5, title: "x" }).catch((e) => e);
    expect(err.code).toBe("GITHUB_UNAVAILABLE");
    expect(err.retryable).toBe(true);
  });

  it("surfaces a 404 on a non-get op as GITHUB_NOT_FOUND (not null)", async () => {
    const { client } = makeClient({
      "POST /repos/acme/web/issues/5/comments": () => jsonResponse(404, { message: "Not Found" }),
    });
    const err = await client.addComment("acme", "web", 5, "hi").catch((e) => e);
    expect(err.code).toBe("GITHUB_NOT_FOUND");
    expect(err.status).toBe(404);
  });

  it("throws GITHUB_UNAVAILABLE when the transport itself fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const client = new RealGithubApi({ auth: { appId: "1", privateKeyPem }, fetch: fetchImpl });
    const err = await client.getIssue("acme", "web", 5).catch((e) => e);
    expect(err.code).toBe("GITHUB_UNAVAILABLE");
    expect(err.retryable).toBe(true);
  });

  it("does not leak the private key material in thrown errors", async () => {
    const client = new RealGithubApi({ auth: { appId: "1", privateKeyPem: "not-a-key" } });
    const err = await client.getIssue("acme", "web", 5).catch((e) => e);
    expect(err.code).toBe("GITHUB_APP_KEY_INVALID");
    expect(JSON.stringify(err.message)).not.toContain("not-a-key");
  });
});
