// 定型文 (0026, #867): personal templates saved / replaced / deleted per account.
import { describe, it, expect } from "vitest";
import type { mail } from "@dub/types";
import { createApp } from "../src/app";
import { fakeIdentityFetcher, makeEnv } from "./helpers";

const app = createApp();
const USERS = { usr_alice: { email: "alice@developershub.jp" }, usr_bob: { email: "bob@developershub.jp" } };
const headers = (u: string) => ({ "content-type": "application/json", "x-dub-request-id": "req_t", "x-dub-user-id": u });
type Env = ReturnType<typeof makeEnv>["env"];
const setup = (allow = true) => makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(allow, USERS) }).env;
const call = (e: Env, u: string, method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`https://svc${path}`, { method, headers: headers(u), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), e);
const list = async (e: Env, u: string) => ((await (await call(e, u, "GET", "/mail/templates")).json()) as mail.MailTemplateList).items;

describe("mail templates", () => {
  it("saves, replaces and deletes a template, scoped to its owner", async () => {
    const env = setup();
    const res = await call(env, "usr_alice", "PUT", "/mail/templates/tpl-1", { title: "面談のご案内", subject: "面談日程について", body: "こんにちは。" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "tpl-1", title: "面談のご案内", subject: "面談日程について", body: "こんにちは。" });
    await call(env, "usr_alice", "PUT", "/mail/templates/tpl-1", { title: "面談のご案内", subject: "", body: "改訂版" });
    // Same client id from another account is a different template.
    await call(env, "usr_bob", "PUT", "/mail/templates/tpl-1", { title: "bob", subject: "s", body: "b" });
    const items = await list(env, "usr_alice");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "tpl-1", subject: "", body: "改訂版" });
    expect((await call(env, "usr_alice", "DELETE", "/mail/templates/tpl-1")).status).toBe(200);
    expect((await call(env, "usr_alice", "DELETE", "/mail/templates/tpl-1")).status).toBe(200);
    expect(await list(env, "usr_alice")).toEqual([]);
    expect((await list(env, "usr_bob")).map((t) => t.title)).toEqual(["bob"]);
  });

  it("rejects a missing title, an oversized field and a bad id", async () => {
    const env = setup();
    expect((await call(env, "usr_alice", "PUT", "/mail/templates/tpl-2", { title: "  ", subject: "", body: "x" })).status).toBe(400);
    expect((await call(env, "usr_alice", "PUT", "/mail/templates/tpl-2", { title: "t", subject: "", body: "x".repeat(50_001) })).status).toBe(400);
    expect((await call(env, "usr_alice", "PUT", "/mail/templates/bad%20id", { title: "t", subject: "", body: "" })).status).toBe(400);
  });

  it("is denied without mail permissions", async () => {
    const env = setup(false);
    expect((await call(env, "usr_alice", "GET", "/mail/templates")).status).toBe(403);
    expect((await call(env, "usr_alice", "PUT", "/mail/templates/tpl-3", { title: "t", subject: "", body: "" })).status).toBe(403);
  });
});
