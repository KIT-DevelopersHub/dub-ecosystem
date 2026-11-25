// 公開 面談日程選択: 未ログインで呼べる・member-service の internal route へ s2s で転送する・
// トークンが無ければ転送しない・member-service のエラー (枠の取り合いなど) はそのまま返す。
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { makeEnv, fakeBinding, json, execCtx } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };

const VIEW = { state: "open", applicantName: "山田 太郎", slots: [], booked: null };

function memberBinding(status = 200) {
  return fakeBinding(() =>
    status === 200 ? json(200, VIEW) : json(status, { error: { code: "HR_SLOT_TAKEN", message: "taken", retryable: false } }),
  );
}

const post = (action: string, body: unknown) =>
  new Request(`https://x/api/v1/public/hr-interview-booking/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/v1/public/hr-interview-booking/*", () => {
  it("forwards only the token s2s with the system actor", async () => {
    const member = memberBinding();
    const res = await createApp(NO_RL).fetch(post("view", { token: "t", extra: "x" }), makeEnv({ SVC_MEMBER: member.fetcher }), execCtx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    const fwd = member.requests[0]!;
    expect(new URL(fwd.url).pathname).toBe("/members/internal/hr/interview-booking/view");
    expect(fwd.headers.get("x-dub-internal")).toBeTruthy();
    expect(fwd.headers.get("x-dub-user-id")).toBe("system:public-hr-interview-booking");
    expect(await fwd.json()).toEqual({ token: "t" });
  });

  it("forwards the slot on book and passes a conflict through", async () => {
    const member = memberBinding(409);
    const res = await createApp(NO_RL).fetch(post("book", { token: "t", slotId: "hsl_1" }), makeEnv({ SVC_MEMBER: member.fetcher }), execCtx);
    expect(res.status).toBe(409);
    expect(await member.requests[0]!.json()).toEqual({ token: "t", slotId: "hsl_1" });
  });

  it("rejects a missing token or slot without forwarding", async () => {
    const member = memberBinding();
    const env = makeEnv({ SVC_MEMBER: member.fetcher });
    expect((await createApp(NO_RL).fetch(post("view", {}), env, execCtx)).status).toBe(400);
    expect((await createApp(NO_RL).fetch(post("book", { token: "t" }), env, execCtx)).status).toBe(400);
    expect(member.requests).toHaveLength(0);
  });
});
