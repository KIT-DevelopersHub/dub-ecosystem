// POST /api/v1/admin/users/:userId/account-mail — アカウント発行メール. Composes member
// reverse lookup + identity user + auth password (view, or issue on 409) + mail /send.
import { describe, it, expect } from "vitest";
import { HDR_INTERNAL } from "@dub/observability";
import type { identity, mail } from "@dub/types";
import { createApp } from "../src/app";
import { ACCOUNT_MAIL_SUBJECT, buildAccountMailBody } from "../src/handlers/account-mail";
import { fakeBinding, validSession, json, makeEnv, execCtx, errOf, type CapturedBinding } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const app = () => createApp(NO_RL);

const PATH = "/internal/admin/users/usr_target/password";

function authSvc(opts: { viewable?: string | null } = {}): CapturedBinding {
  return fakeBinding((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/verify") return json(200, validSession("usr_admin"));
    if (path === PATH && req.method === "GET") {
      return opts.viewable
        ? json(200, { userId: "usr_target", email: "taro@developershub.jp", password: opts.viewable })
        : json(409, { error: { code: "AUTH_PASSWORD_NOT_VIEWABLE", message: "not viewable", retryable: false } });
    }
    if (path === PATH && req.method === "POST") return json(200, { ok: true, password: "Gen3rated!pw" });
    return json(404, {});
  });
}

function identitySvc(perms: string[] = ["identity:admin"]): CapturedBinding {
  return fakeBinding(async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/authz/check") {
      const body = (await req.json()) as identity.AuthzCheckRequest;
      return json(200, {
        decisions: body.checks.map((q) => ({ allowed: perms.includes(q.permission), evaluatedAt: "2026-01-01T00:00:00Z", ttlSeconds: 60 })),
      } satisfies identity.AuthzCheckResponse);
    }
    if (path === "/users/usr_target") return json(200, { id: "usr_target", email: "taro@developershub.jp", displayName: "山田 太郎" });
    return json(404, {});
  });
}

function memberSvc(member: { name: string; gmail: string | null } | null): CapturedBinding {
  return fakeBinding((req) =>
    new URL(req.url).pathname === "/members/people/by-identity/usr_target" ? json(200, { member }) : json(404, {}),
  );
}

function mailSvc(): CapturedBinding {
  return fakeBinding(() => json(200, { messageId: "msg_1", provider: "resend", acceptedAt: "2026-01-01T00:00:00Z" }));
}

function send(env: ReturnType<typeof makeEnv>) {
  return app().fetch(
    new Request("https://x/api/v1/admin/users/usr_target/account-mail", {
      method: "POST",
      headers: { authorization: "Bearer admin-tok", "content-type": "application/json" },
      body: "{}",
    }),
    env,
    execCtx,
  );
}

describe("buildAccountMailBody", () => {
  it("contains name, app url, login, password, change notice and cc notice", () => {
    const body = buildAccountMailBody({ name: "山田 太郎", appUrl: "https://app.example", loginEmail: "taro@developershub.jp", password: "Pw-1" });
    expect(body).toContain("山田 太郎 さん");
    expect(body).toContain("アプリ URL: https://app.example");
    expect(body).toContain("ログインメールアドレス: taro@developershub.jp");
    expect(body).toContain("初期パスワード: Pw-1");
    expect(body).toContain("ログイン後にパスワードを変更してください");
    expect(body).toContain("このメールは taro@developershub.jp にも CC しています");
  });
});

describe("POST /api/v1/admin/users/:id/account-mail", () => {
  it("existing password: sends it to the Gmail with the devhub address in cc (system send)", async () => {
    const auth = authSvc({ viewable: "Curr3nt!pw" });
    const mailB = mailSvc();
    const env = makeEnv({
      SVC_AUTH: auth.fetcher,
      SVC_IDENTITY: identitySvc().fetcher,
      SVC_MEMBER: memberSvc({ name: "山田 太郎", gmail: "taro.yamada@gmail.com" }).fetcher,
      SVC_MAIL_GATEWAY: mailB.fetcher,
    });
    const res = await send(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      to: "taro.yamada@gmail.com",
      cc: "taro@developershub.jp",
      appUrl: "https://app.developershub.jp",
      passwordSource: "existing",
      messageId: "msg_1",
    });
    // no password was issued
    expect(auth.requests.some((r) => r.method === "POST" && new URL(r.url).pathname === PATH)).toBe(false);

    const fwd = mailB.requests.find((r) => new URL(r.url).pathname === "/send");
    expect(fwd).toBeDefined();
    expect(fwd!.headers.get(HDR_INTERNAL)).toBe("1");
    expect(fwd!.headers.get("x-dub-user-id")).toBeNull();
    expect(fwd!.headers.get("x-dub-idempotency-key")).toMatch(/^account-mail:usr_target:/);
    const sent = (await fwd!.json()) as mail.SendMailRequest;
    expect(sent.to).toEqual([{ email: "taro.yamada@gmail.com", name: "山田 太郎" }]);
    expect(sent.cc).toEqual([{ email: "taro@developershub.jp" }]);
    expect(sent.subject).toBe(ACCOUNT_MAIL_SUBJECT);
    expect(sent.textBody).toContain("初期パスワード: Curr3nt!pw");
  });

  it("no viewable password: issues one (generate + mustChange) and sends it", async () => {
    const auth = authSvc({ viewable: null });
    const mailB = mailSvc();
    const env = makeEnv({
      SVC_AUTH: auth.fetcher,
      SVC_IDENTITY: identitySvc().fetcher,
      SVC_MEMBER: memberSvc({ name: "山田 太郎", gmail: "taro.yamada@gmail.com" }).fetcher,
      SVC_MAIL_GATEWAY: mailB.fetcher,
      APP_BASE_URL: "https://app.example",
    });
    const res = await send(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { passwordSource: string; appUrl: string };
    expect(body.passwordSource).toBe("generated");
    expect(body.appUrl).toBe("https://app.example");

    const issue = auth.requests.find((r) => r.method === "POST" && new URL(r.url).pathname === PATH);
    expect(await issue!.json()).toEqual({ generate: true, mustChange: true });
    const sent = (await mailB.requests[0]!.json()) as mail.SendMailRequest;
    expect(sent.textBody).toContain("初期パスワード: Gen3rated!pw");
    expect(sent.textBody).toContain("アプリ URL: https://app.example");
  });

  it("member without a Gmail: 400 validation, no password touched, nothing sent", async () => {
    const auth = authSvc({ viewable: null });
    const mailB = mailSvc();
    const env = makeEnv({
      SVC_AUTH: auth.fetcher,
      SVC_IDENTITY: identitySvc().fetcher,
      SVC_MEMBER: memberSvc({ name: "山田 太郎", gmail: null }).fetcher,
      SVC_MAIL_GATEWAY: mailB.fetcher,
    });
    const res = await send(env);
    expect(res.status).toBe(400);
    expect((await errOf(res)).code).toBe("VALIDATION_FAILED");
    expect(auth.requests.some((r) => new URL(r.url).pathname === PATH)).toBe(false);
    expect(mailB.requests).toHaveLength(0);
  });

  it("account not linked to any member: 400 validation", async () => {
    const mailB = mailSvc();
    const env = makeEnv({
      SVC_AUTH: authSvc({ viewable: "x" }).fetcher,
      SVC_IDENTITY: identitySvc().fetcher,
      SVC_MEMBER: memberSvc(null).fetcher,
      SVC_MAIL_GATEWAY: mailB.fetcher,
    });
    const res = await send(env);
    expect(res.status).toBe(400);
    expect(mailB.requests).toHaveLength(0);
  });

  it("non-admin: 403 before any downstream call", async () => {
    const auth = authSvc({ viewable: "x" });
    const member = memberSvc({ name: "山田 太郎", gmail: "taro.yamada@gmail.com" });
    const mailB = mailSvc();
    const env = makeEnv({
      SVC_AUTH: auth.fetcher,
      SVC_IDENTITY: identitySvc(["identity:read"]).fetcher,
      SVC_MEMBER: member.fetcher,
      SVC_MAIL_GATEWAY: mailB.fetcher,
    });
    const res = await send(env);
    expect(res.status).toBe(403);
    expect(member.requests).toHaveLength(0);
    expect(mailB.requests).toHaveLength(0);
  });
});
