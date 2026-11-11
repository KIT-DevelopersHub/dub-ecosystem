// POST /api/v1/admin/hr/applicants/:applicantId/interview-result — 面談結果の登録。
// member claim → (合格: identity/mail の発行 → member link → auth 初期パスワード + /send) → member complete。
import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { createApp } from "../src/app";
import { fakeBinding, validSession, json, makeEnv, execCtx, errOf, type CapturedBinding } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const URL_ = "https://x/api/v1/admin/hr/applicants/app_1/interview-result";
const BASE = "/members/internal/hr/applicants/app_1/interview-result";
const ADDRESS = "taro.yamada@developershub.jp";
const APPLICANT = { id: "app_1", name: "山田 太郎", nameKana: "やまだ たろう", email: "taro@gmail.com", stage: "interview_set" };
const RESULT = { id: "hir_1", applicantId: "app_1", decision: "pass", status: "processing", issuedIdentityUserId: null, issuedAddress: null };

const path = (r: Request): string => new URL(r.url).pathname;
const hit = (b: CapturedBinding, p: string): Request[] => b.requests.filter((r) => path(r) === p);

function setup(o: { perms?: string[]; claim?: Response; complete?: Response } = {}) {
  const perms = o.perms ?? ["hr:write", "members:onboard_mail"];
  const auth = fakeBinding((req) => {
    if (path(req) === "/verify") return json(200, validSession("usr_hr"));
    if (path(req) === "/internal/onboard/users/usr_new/initial-password") return json(200, { ok: true, password: "Init!al-pw" });
    return json(404, {});
  });
  const idn = fakeBinding(async (req) => {
    const p = path(req);
    if (p === "/authz/check") {
      const body = (await req.json()) as identity.AuthzCheckRequest;
      return json(200, {
        decisions: body.checks.map((q) => ({ allowed: perms.includes(q.permission), evaluatedAt: "2026-01-01T00:00:00Z", ttlSeconds: 60 })),
      } satisfies identity.AuthzCheckResponse);
    }
    if (p === "/internal/users/lookup") return json(200, { user: null });
    if (p === "/internal/users/onboard") return json(201, { user: { id: "usr_new", email: ADDRESS, status: "invited" } });
    return json(404, {});
  });
  const mem = fakeBinding(async (req) => {
    const p = path(req);
    if (p === `${BASE}/claim`) {
      if (o.claim) return o.claim;
      const b = (await req.clone().json()) as { decision: string };
      return json(200, { result: { ...RESULT, decision: b.decision }, applicant: APPLICANT, proceed: true });
    }
    if (p === `${BASE}/link`) return json(200, { ...APPLICANT, stage: "hired", memberId: "mem_1" });
    if (p === `${BASE}/complete`) return o.complete ?? json(200, { result: { ...RESULT, status: "done" }, applicant: { ...APPLICANT, stage: "hired" } });
    if (p === `${BASE}/release`) return json(200, { ok: true });
    return json(404, {});
  });
  const mailB = fakeBinding((req) => {
    const p = path(req);
    if (p === "/internal/email-routing/issued-addresses/lookup") return json(200, { taken: false });
    if (p === "/internal/email-routing/issued-addresses") return json(201, { id: "rule_1", address: ADDRESS, localPart: "taro.yamada" });
    if (p === "/internal/email-routing/issued-addresses/revoke") return json(200, { revoked: true });
    if (p === "/send") return json(200, { messageId: "msg_1", provider: "resend", acceptedAt: "2026-01-01T00:00:00Z" });
    return json(404, {});
  });
  const env = makeEnv({ SVC_AUTH: auth.fetcher, SVC_IDENTITY: idn.fetcher, SVC_MEMBER: mem.fetcher, SVC_MAIL_GATEWAY: mailB.fetcher });
  const send = (body: unknown) =>
    createApp(NO_RL).fetch(
      new Request(URL_, { method: "POST", headers: { authorization: "Bearer hr-tok", "content-type": "application/json" }, body: JSON.stringify(body) }),
      env,
      execCtx,
    );
  return { auth, idn, mem, mailB, send };
}

describe("POST /api/v1/admin/hr/applicants/:id/interview-result", () => {
  it("pass: issues the address + account once, links it, sends the login mail to the applicant, then completes", async () => {
    const s = setup();
    const res = await s.send({ decision: "pass", reason: "良い", localPart: "Taro.Yamada" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ alreadyRegistered: false, accountMailSent: true, result: { status: "done" } });
    expect(hit(s.mailB, "/internal/email-routing/issued-addresses")).toHaveLength(1);
    expect(hit(s.idn, "/internal/users/onboard")).toHaveLength(1);
    expect(await hit(s.idn, "/internal/users/onboard")[0]!.json()).toEqual({ email: ADDRESS, displayName: "山田 太郎", furigana: "やまだ たろう" });
    expect(await hit(s.mem, `${BASE}/link`)[0]!.json()).toEqual({ identityUserId: "usr_new", address: ADDRESS });
    const sent = hit(s.mailB, "/send");
    expect(sent).toHaveLength(1);
    const mail = (await sent[0]!.json()) as { to: { email: string }[]; cc: { email: string }[] };
    expect(mail.to[0]!.email).toBe("taro@gmail.com");
    expect(mail.cc[0]!.email).toBe(ADDRESS);
    expect(hit(s.mem, `${BASE}/complete`)).toHaveLength(1);
    expect(hit(s.mem, `${BASE}/release`)).toHaveLength(0);
  });

  it("fail: no account, no address — only claim and complete", async () => {
    const s = setup();
    const res = await s.send({ decision: "fail", reason: "今回は見送り" });
    expect(res.status).toBe(201);
    expect(s.mailB.requests).toHaveLength(0);
    expect(hit(s.idn, "/internal/users/onboard")).toHaveLength(0);
    expect(hit(s.mem, `${BASE}/complete`)).toHaveLength(1);
  });

  it("already registered (double click): returns the stored result and issues nothing", async () => {
    const s = setup({ claim: json(200, { result: { ...RESULT, status: "done" }, applicant: APPLICANT, proceed: false }) });
    const res = await s.send({ decision: "pass", reason: "良い", localPart: "taro.yamada" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyRegistered: true });
    expect(s.mailB.requests).toHaveLength(0);
    expect(hit(s.idn, "/internal/users/onboard")).toHaveLength(0);
    expect(hit(s.mem, `${BASE}/complete`)).toHaveLength(0);
  });

  it("in progress (concurrent second press): 409 passes through and nothing is issued", async () => {
    const s = setup({ claim: json(409, { error: { code: "HR_RESULT_IN_PROGRESS", message: "途中", retryable: true } }) });
    const res = await s.send({ decision: "pass", reason: "良い", localPart: "taro.yamada" });
    expect(res.status).toBe(409);
    expect((await errOf(res)).code).toBe("HR_RESULT_IN_PROGRESS");
    expect(s.mailB.requests).toHaveLength(0);
  });

  it("retry after the account was issued: re-links with the stored account, never issues a second one", async () => {
    const s = setup({
      claim: json(200, {
        result: { ...RESULT, issuedIdentityUserId: "usr_new", issuedAddress: ADDRESS },
        applicant: APPLICANT,
        proceed: true,
      }),
    });
    const res = await s.send({ decision: "pass", reason: "良い", localPart: "other" });
    expect(res.status).toBe(201);
    expect(hit(s.idn, "/internal/users/onboard")).toHaveLength(0);
    expect(hit(s.mailB, "/internal/email-routing/issued-addresses")).toHaveLength(0);
    expect(await hit(s.mem, `${BASE}/link`)[0]!.json()).toEqual({ identityUserId: "usr_new", address: ADDRESS });
  });

  it("a failed completion releases the lease so the next press resumes", async () => {
    const s = setup({ complete: json(502, { error: { code: "HR_RESULT_MAIL_FAILED", message: "x", retryable: true } }) });
    const res = await s.send({ decision: "fail", reason: "x" });
    expect(res.status).toBe(502);
    expect(hit(s.mem, `${BASE}/release`)).toHaveLength(1);
  });

  it("validates before touching anything, and 403s without both keys", async () => {
    const s = setup();
    expect((await s.send({ decision: "pass", reason: "x", localPart: "admin" })).status).toBe(400);
    expect((await s.send({ decision: "pass", reason: "", localPart: "taro" })).status).toBe(400);
    expect(s.mem.requests).toHaveLength(0);
    const noKey = setup({ perms: ["hr:write"] });
    expect((await noKey.send({ decision: "fail", reason: "x" })).status).toBe(403);
    expect(noKey.mem.requests).toHaveLength(0);
  });
});
