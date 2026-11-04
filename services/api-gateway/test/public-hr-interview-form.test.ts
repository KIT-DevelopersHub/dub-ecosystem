// 公開 面談申し込みフォーム: 未ログインで読めて送れる・member-service の internal route へ s2s で転送する・
// 囮フィールドが埋まっていたら転送しない・Turnstile が失敗したら 403・応答は accepted だけ。
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { makeEnv, fakeBinding, json, execCtx } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };

const FORM = {
  title: "面談申し込みフォーム",
  description: null,
  accepting: true,
  questions: [{ id: "name", type: "short_text", label: "お名前", description: null, required: true, options: [], binding: "name" }],
};

function memberBinding() {
  return fakeBinding((req) => {
    const path = new URL(req.url).pathname;
    if (path !== "/members/internal/hr/interview-form") return json(404, { error: { code: "NOT_FOUND", message: "no", retryable: false } });
    return req.method === "GET" ? json(200, { ...FORM, version: 3 }) : json(201, { accepted: true, responseId: "hfr_1" });
  });
}

const post = (body: unknown) =>
  new Request("https://x/api/v1/public/hr-interview-form", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /api/v1/public/hr-interview-form", () => {
  it("is reachable without a session and returns only the public shape", async () => {
    const member = memberBinding();
    const res = await createApp(NO_RL).fetch(
      new Request("https://x/api/v1/public/hr-interview-form"),
      makeEnv({ SVC_MEMBER: member.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FORM);
    expect(member.requests[0]!.headers.get("x-dub-internal")).toBeTruthy();
  });
});

describe("POST /api/v1/public/hr-interview-form", () => {
  it("forwards the answers s2s with the system actor and answers { accepted } only", async () => {
    const member = memberBinding();
    const res = await createApp(NO_RL).fetch(post({ answers: { name: "山田 太郎" } }), makeEnv({ SVC_MEMBER: member.fetcher }), execCtx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    const fwd = member.requests[0]!;
    expect(fwd.method).toBe("POST");
    expect(fwd.headers.get("x-dub-internal")).toBeTruthy();
    expect(fwd.headers.get("x-dub-user-id")).toBe("system:public-hr-interview-form");
    expect(await fwd.json()).toEqual({ answers: { name: "山田 太郎" } });
  });

  it("silently drops a submission whose honeypot is filled (no forward)", async () => {
    const member = memberBinding();
    const res = await createApp(NO_RL).fetch(
      post({ answers: { name: "bot" }, website: "http://spam.example" }),
      makeEnv({ SVC_MEMBER: member.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect(member.requests).toHaveLength(0);
  });

  it("rejects a failed Turnstile check and a missing answers object", async () => {
    const member = memberBinding();
    const failing = await createApp({ ...NO_RL, turnstile: async () => false }).fetch(
      post({ answers: { name: "x" }, turnstileToken: "bad" }),
      makeEnv({ SVC_MEMBER: member.fetcher }),
      execCtx,
    );
    expect(failing.status).toBe(403);
    const bad = await createApp(NO_RL).fetch(post({ answers: "x" }), makeEnv({ SVC_MEMBER: member.fetcher }), execCtx);
    expect(bad.status).toBe(400);
    expect(member.requests).toHaveLength(0);
  });
});
