// POST /mail/avatars — sender icons resolved from the Dub roster (Dub users only).
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { mail } from "@dub/types";
import { createApp } from "../src/app";
import { fakeIdentityFetcher, makeEnv } from "./helpers";

const app = createApp();
const USERS = {
  usr_alice: { email: "alice@developershub.jp", avatarUrl: "https://img.example/alice.png" },
  usr_bob: { email: "bob@developershub.jp" },
};
const asUser = { "content-type": "application/json", "x-dub-request-id": "req_avatar", "x-dub-user-id": "usr_alice" };
const post = (env: ReturnType<typeof makeEnv>["env"], body: unknown) =>
  app.request("/mail/avatars", { method: "POST", headers: asUser, body: JSON.stringify(body) }, env);

describe("POST /mail/avatars", () => {
  it("returns avatars only for Dub users that set one (normalized, deduped)", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, USERS) });
    const res = await post(env, { emails: [" Alice@DeveloperSHub.jp", "alice@developershub.jp", "bob@developershub.jp", "stranger@gmail.com"] });
    expect(res.status).toBe(200);
    expect((await res.json()) as mail.MailAvatarsResponse).toEqual({ avatars: { "alice@developershub.jp": "https://img.example/alice.png" } });
  });

  it("degrades to no avatars when identity is unavailable", async () => {
    const broken = { fetch: async () => new Response("boom", { status: 500 }) } as unknown as Fetcher;
    const allowAll = fakeIdentityFetcher(true, USERS);
    const identity = {
      fetch: (req: Request) => (new URL(req.url).pathname === "/internal/users/avatars" ? broken.fetch(req) : allowAll.fetch(req)),
    } as unknown as Fetcher;
    const { env } = makeEnv({ SVC_IDENTITY: identity });
    const res = await post(env, { emails: ["alice@developershub.jp"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ avatars: {} });
  });

  it("400s on a missing or oversized emails list", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, USERS) });
    expect((await post(env, {})).status).toBe(400);
    expect((await post(env, { emails: Array.from({ length: 51 }, (_, i) => `u${i}@x.jp`) })).status).toBe(400);
  });

  it("403s without mail:read", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false, USERS) });
    expect((await post(env, { emails: ["alice@developershub.jp"] })).status).toBe(403);
  });
});
