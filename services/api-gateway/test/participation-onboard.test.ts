// POST /api/v1/admin/participation/:participationId/onboard-account — 参加届からのアカウント
// 発行 (人事向け・members:onboard_mail). Composes member onboard-target/link + identity
// lookup/onboard + mail issue + (optional) auth initial password + mail /send, with rollback.
import { describe, it, expect } from "vitest";
import type { identity, mail } from "@dub/types";
import { createApp } from "../src/app";
import { fakeBinding, validSession, json, makeEnv, execCtx, errOf, type CapturedBinding } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const URL_ = "https://x/api/v1/admin/participation/pt_1/onboard-account";
const ADDRESS = "taro.yamada@developershub.jp";

const MEMBER = { id: "mem_1", name: "山田 太郎", gmail: "taro@gmail.com", identityUserId: null, version: 3 };
const PARTICIPATION = { id: "pt_1", name: "山田 太郎", lastNameKana: "やまだ", firstNameKana: "たろう", reviewState: "added", memberId: "mem_1" };

const path = (r: Request): string => new URL(r.url).pathname;
const hit = (b: CapturedBinding, p: string): Request[] => b.requests.filter((r) => path(r) === p);

interface Opts {
  perms?: string[];
  target?: Response;
  lookupUser?: unknown;
  onboard?: Response;
  link?: Response | Response[];
  send?: Response;
  issue?: Response;
  taken?: boolean;
  lookupAfterOnboard?: unknown;
  discard?: Response;
}

function setup(o: Opts = {}) {
  const perms = o.perms ?? ["members:onboard_mail"];
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
    if (p === "/internal/users/lookup") {
      const onboarded = idn.requests.some((r) => path(r) === "/internal/users/onboard");
      return json(200, { user: onboarded && o.lookupAfterOnboard ? o.lookupAfterOnboard : (o.lookupUser ?? null) });
    }
    if (p === "/internal/users/onboard") return o.onboard ?? json(201, { user: { id: "usr_new", email: ADDRESS, status: "invited" } });
    if (p === "/internal/users/usr_new/discard-onboard") return o.discard ?? json(200, { discarded: true });
    return json(404, {});
  });
  const links = Array.isArray(o.link) ? [...o.link] : o.link ? [o.link] : [];
  const mem = fakeBinding((req) => {
    const p = path(req);
    if (p === "/members/internal/participation/pt_1/onboard-target") return o.target ?? json(200, { participation: PARTICIPATION, member: MEMBER });
    if (p === "/members/internal/participation/pt_1/onboard-link") {
      const next = links.length > 1 ? links.shift()! : links[0];
      return next ?? json(200, { ...MEMBER, identityUserId: "usr_new", version: 4 });
    }
    return json(404, {});
  });
  const mailB = fakeBinding((req) => {
    const p = path(req);
    if (p === "/internal/email-routing/issued-addresses/lookup") return json(200, { taken: o.taken ?? false });
    if (p === "/internal/email-routing/issued-addresses") return o.issue ?? json(201, { id: "rule_1", address: ADDRESS, localPart: "taro.yamada" });
    if (p === "/internal/email-routing/issued-addresses/revoke") return json(200, { revoked: true, id: "rule_1" });
    if (p === "/send") return o.send ?? json(200, { messageId: "msg_1", provider: "resend", acceptedAt: "2026-01-01T00:00:00Z" });
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

describe("POST /api/v1/admin/participation/:id/onboard-account", () => {
  it("succeeds with members:onboard_mail alone (no identity:admin / mail:admin / ロール管理編集)", async () => {
    const s = setup();
    const res = await s.send({ localPart: "Taro.Yamada" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      address: ADDRESS,
      identityUserId: "usr_new",
      member: { ...MEMBER, identityUserId: "usr_new", version: 4 },
      accountMail: { requested: false, sent: false, to: "taro@gmail.com" },
    });
    expect(await hit(s.mailB, "/internal/email-routing/issued-addresses")[0]!.json()).toEqual({ localPart: "taro.yamada" });
    expect(hit(s.mailB, "/internal/email-routing/issued-addresses/revoke")).toHaveLength(0);
    expect(await hit(s.idn, "/internal/users/onboard")[0]!.json()).toEqual({ email: ADDRESS, displayName: "山田 太郎", furigana: "やまだ たろう" });
    expect(await hit(s.mem, "/members/internal/participation/pt_1/onboard-link")[0]!.json()).toEqual({ identityUserId: "usr_new" });
    // the caller is forwarded as the actor (granted_by / audit)
    expect(hit(s.idn, "/internal/users/onboard")[0]!.headers.get("x-dub-user-id")).toBe("usr_hr");
    // no mail requested -> no password touched, nothing sent
    expect(s.auth.requests.some((r) => path(r).includes("initial-password"))).toBe(false);
    expect(hit(s.mailB, "/send")).toHaveLength(0);
  });

  it("403 without members:onboard_mail — even holding the old 5 conditions' keys — and nothing is created", async () => {
    const s = setup({ perms: ["identity:admin", "mail:admin", "members:mail_edit", "app:admin:edit", "app:members:edit"] });
    const res = await s.send({ localPart: "taro.yamada" });
    expect(res.status).toBe(403);
    expect(s.mem.requests).toHaveLength(0);
    expect(s.mailB.requests).toHaveLength(0);
    expect(hit(s.idn, "/internal/users/onboard")).toHaveLength(0);
  });

  it("refuses a person who already has an account (member-service 409), before anything is created", async () => {
    const s = setup({
      target: json(409, { error: { code: "MEMBER_ONBOARD_ALREADY_HAS_ACCOUNT", message: "この人には既にアカウントがあります", retryable: false } }),
    });
    const res = await s.send({ localPart: "taro.yamada" });
    expect(res.status).toBe(409);
    expect((await errOf(res)).code).toBe("MEMBER_ONBOARD_ALREADY_HAS_ACCOUNT");
    expect(s.mailB.requests).toHaveLength(0);
    expect(hit(s.idn, "/internal/users/onboard")).toHaveLength(0);
  });

  it("refuses an address that already has an account (never touches the existing one)", async () => {
    const s = setup({ lookupUser: { id: "usr_existing", email: ADDRESS, status: "active" } });
    const res = await s.send({ localPart: "taro.yamada" });
    expect(res.status).toBe(409);
    expect((await errOf(res)).code).toBe("GATEWAY_ONBOARD_EMAIL_EXISTS");
    expect(s.mailB.requests).toHaveLength(0);
    expect(hit(s.idn, "/internal/users/onboard")).toHaveLength(0);
  });

  it("ignores roles in the request: the onboard call never carries roleIds", async () => {
    const s = setup();
    const res = await s.send({ localPart: "taro.yamada", roleIds: ["role_sys_admin"], roles: ["admin"] });
    expect(res.status).toBe(201);
    const body = (await hit(s.idn, "/internal/users/onboard")[0]!.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("roleIds");
    expect(body).not.toHaveProperty("roles");
    // no role-assignment route was called
    expect(s.idn.requests.some((r) => /\/roles/.test(path(r)))).toBe(false);
  });

  it("rejects a malformed or reserved local part with 400 before any call", async () => {
    const s = setup();
    expect((await s.send({ localPart: "山田" })).status).toBe(400);
    for (const reserved of ["info", "archive", "postmaster", "Admin"]) {
      const res = await s.send({ localPart: reserved });
      expect(res.status).toBe(400);
    }
    expect(s.mem.requests).toHaveLength(0);
  });

  it("refuses an address that is already routed (forwarding rule / list) before creating anything", async () => {
    const s = setup({ taken: true });
    const res = await s.send({ localPart: "taro.yamada" });
    expect(res.status).toBe(409);
    expect(hit(s.mailB, "/internal/email-routing/issued-addresses")).toHaveLength(0);
    expect(hit(s.mailB, "/internal/email-routing/issued-addresses/revoke")).toHaveLength(0);
  });

  it("address issue times out (unknown outcome) -> revoked by address, retry can start clean", async () => {
    const s = setup({ issue: json(503, { error: { code: "UPSTREAM_UNAVAILABLE", message: "down", retryable: true } }) });
    const res = await s.send({ localPart: "taro.yamada" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await hit(s.mailB, "/internal/email-routing/issued-addresses/revoke")[0]!.json()).toEqual({ address: ADDRESS });
    expect(hit(s.idn, "/internal/users/onboard")).toHaveLength(0);
  });

  it("address issue refused (4xx) -> nothing to undo", async () => {
    const s = setup({ issue: json(409, { error: { code: "MAIL_EMAIL_ROUTING_CONFLICT", message: "x", retryable: false } }) });
    const res = await s.send({ localPart: "taro.yamada" });
    expect(res.status).toBe(409);
    expect(hit(s.mailB, "/internal/email-routing/issued-addresses/revoke")).toHaveLength(0);
  });

  it("account creation fails with unknown outcome -> the account it may have made is found by address and discarded, then the address revoked", async () => {
    const s = setup({
      onboard: json(503, { error: { code: "UPSTREAM_UNAVAILABLE", message: "down", retryable: true } }),
      lookupAfterOnboard: { id: "usr_new", email: ADDRESS, status: "invited" },
    });
    const res = await s.send({ localPart: "taro.yamada" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(hit(s.idn, "/internal/users/usr_new/discard-onboard")).toHaveLength(1);
    expect(hit(s.mailB, "/internal/email-routing/issued-addresses/revoke")).toHaveLength(1);
    expect(hit(s.mem, "/members/internal/participation/pt_1/onboard-link")).toHaveLength(0);
  });

  it("link fails -> the invite is discarded and the address revoked (retry starts clean)", async () => {
    const s = setup({ link: json(409, { error: { code: "MEMBER_ONBOARD_ALREADY_HAS_ACCOUNT", message: "x", retryable: false } }) });
    const res = await s.send({ localPart: "taro.yamada" });
    expect(res.status).toBe(409);
    expect(hit(s.idn, "/internal/users/usr_new/discard-onboard")).toHaveLength(1);
    expect(hit(s.mailB, "/internal/email-routing/issued-addresses/revoke")).toHaveLength(1);
  });

  it("account cannot be undone -> the address is KEPT and a 502 lists the leftovers", async () => {
    const s = setup({
      link: json(409, { error: { code: "MEMBER_ONBOARD_ALREADY_HAS_ACCOUNT", message: "x", retryable: false } }),
      discard: json(409, { error: { code: "IDENTITY_NOT_DISCARDABLE", message: "x", retryable: false } }),
    });
    const res = await s.send({ localPart: "taro.yamada" });
    expect(res.status).toBe(502);
    const err = await errOf(res);
    expect(err.code).toBe("GATEWAY_ONBOARD_PARTIAL");
    expect(hit(s.mailB, "/internal/email-routing/issued-addresses/revoke")).toHaveLength(0);
  });

  it("link response lost (5xx) but the re-check succeeds -> kept, nothing undone", async () => {
    const s = setup({ link: [json(503, { error: { code: "UPSTREAM_UNAVAILABLE", message: "x", retryable: true } }), json(200, { ...MEMBER, identityUserId: "usr_new", version: 4 })] });
    const res = await s.send({ localPart: "taro.yamada" });
    expect(res.status).toBe(201);
    expect(hit(s.mem, "/members/internal/participation/pt_1/onboard-link")).toHaveLength(2);
    expect(hit(s.idn, "/internal/users/usr_new/discard-onboard")).toHaveLength(0);
    expect(hit(s.mailB, "/internal/email-routing/issued-addresses/revoke")).toHaveLength(0);
  });

  it("sendAccountMail: issues an initial password for the NEW account only and sends it to the Gmail", async () => {
    const s = setup();
    const res = await s.send({ localPart: "taro.yamada", sendAccountMail: true });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { accountMail: unknown }).accountMail).toEqual({ requested: true, sent: true, to: "taro@gmail.com" });
    expect(s.auth.requests.filter((r) => path(r).includes("password"))).toHaveLength(1); // never the view / admin set route
    expect(hit(s.auth, "/internal/onboard/users/usr_new/initial-password")).toHaveLength(1);
    const fwd = hit(s.mailB, "/send")[0]!;
    expect(fwd.headers.get("x-dub-user-id")).toBeNull(); // system send
    const sent = (await fwd.json()) as mail.SendMailRequest;
    expect(sent.to).toEqual([{ email: "taro@gmail.com", name: "山田 太郎" }]);
    expect(sent.cc).toEqual([{ email: ADDRESS }]);
    expect(sent.textBody).toContain("初期パスワード: Init!al-pw");
  });

  it("mail send failure keeps the issued account (201, sent=false)", async () => {
    const s = setup({ send: json(500, { error: { code: "INTERNAL", message: "x", retryable: false } }) });
    const res = await s.send({ localPart: "taro.yamada", sendAccountMail: true });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { accountMail: unknown }).accountMail).toEqual({ requested: true, sent: false, to: "taro@gmail.com" });
    expect(hit(s.idn, "/internal/users/usr_new/discard-onboard")).toHaveLength(0);
  });
});
