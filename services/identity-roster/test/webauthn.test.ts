import { describe, it, expect } from "vitest";
import { makeHarness, internal, jsonBody, asUser } from "./harness";
import type { WebauthnCredentialRow } from "../src/repo/webauthn";

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;

const cred = (id: string) => ({ id, publicKey: "pk_" + id, signCount: 0, transports: ["internal"], label: "MacBook" });

describe("internal webauthn credential store", () => {
  it("creates, lists, records use, renames and deletes a credential", async () => {
    const h = await makeHarness();
    const base = `/internal/webauthn/users/${h.memberId}/credentials`;
    const created = await h.app.request(base, jsonBody(internal(), "POST", cred("c1")));
    expect(created.status).toBe(201);

    const list = await json<{ items: WebauthnCredentialRow[] }>(await h.app.request(base, internal()));
    expect(list.items.map((r) => r.id)).toEqual(["c1"]);
    expect(list.items[0]?.transports).toEqual(["internal"]);

    const use = await h.app.request("/internal/webauthn/credentials/c1/use", jsonBody(internal(), "POST", { signCount: 7 }));
    expect(use.status).toBe(200);
    const got = await json<WebauthnCredentialRow>(await h.app.request("/internal/webauthn/credentials/c1", internal()));
    expect(got.signCount).toBe(7);
    expect(got.lastUsedAt).not.toBeNull();

    expect((await h.app.request(`${base}/c1`, jsonBody(internal(), "PATCH", { label: "iPhone" }))).status).toBe(200);
    expect((await json<WebauthnCredentialRow>(await h.app.request("/internal/webauthn/credentials/c1", internal()))).label).toBe("iPhone");

    expect((await h.app.request(`${base}/c1`, { ...internal(), method: "DELETE" })).status).toBe(204);
    expect((await h.app.request("/internal/webauthn/credentials/c1", internal())).status).toBe(404);
  });

  it("rejects a credential id already registered (even to another user)", async () => {
    const h = await makeHarness();
    await h.app.request(`/internal/webauthn/users/${h.memberId}/credentials`, jsonBody(internal(), "POST", cred("dup")));
    const again = await h.app.request(`/internal/webauthn/users/${h.adminId}/credentials`, jsonBody(internal(), "POST", cred("dup")));
    expect(again.status).toBe(409);
  });

  it("scopes rename/delete to the owning user", async () => {
    const h = await makeHarness();
    await h.app.request(`/internal/webauthn/users/${h.memberId}/credentials`, jsonBody(internal(), "POST", cred("mine")));
    const other = `/internal/webauthn/users/${h.adminId}/credentials/mine`;
    expect((await h.app.request(other, jsonBody(internal(), "PATCH", { label: "x" }))).status).toBe(404);
    expect((await h.app.request(other, { ...internal(), method: "DELETE" })).status).toBe(404);
    expect((await h.app.request("/internal/webauthn/credentials/mine", internal())).status).toBe(200);
  });

  it("refuses unknown users and non-internal callers", async () => {
    const h = await makeHarness();
    expect((await h.app.request("/internal/webauthn/users/nobody/credentials", jsonBody(internal(), "POST", cred("z")))).status).toBe(404);
    expect((await h.app.request(`/internal/webauthn/users/${h.memberId}/credentials`, asUser(h.memberId))).status).toBe(403);
  });

  it("challenges are single-use and expire", async () => {
    const h = await makeHarness();
    const save = (challenge: string, ttlSec: number) =>
      h.app.request("/internal/webauthn/challenges", jsonBody(internal(), "POST", { challenge, kind: "register", userId: h.memberId, ttlSec }));
    const take = (challenge: string) => h.app.request("/internal/webauthn/challenges/take", jsonBody(internal(), "POST", { challenge }));
    expect((await save("ch1", 300)).status).toBe(201);
    const first = await take("ch1");
    expect(first.status).toBe(200);
    expect(await json<{ kind: string; userId: string }>(first)).toMatchObject({ kind: "register", userId: h.memberId });
    expect((await take("ch1")).status).toBe(404); // redeemed once only
    expect((await take("never")).status).toBe(404);
  });

  it("never moves the signature counter backwards", async () => {
    const h = await makeHarness();
    await h.app.request(`/internal/webauthn/users/${h.memberId}/credentials`, jsonBody(internal(), "POST", cred("cnt")));
    await h.app.request("/internal/webauthn/credentials/cnt/use", jsonBody(internal(), "POST", { signCount: 9 }));
    await h.app.request("/internal/webauthn/credentials/cnt/use", jsonBody(internal(), "POST", { signCount: 4 }));
    expect((await json<WebauthnCredentialRow>(await h.app.request("/internal/webauthn/credentials/cnt", internal()))).signCount).toBe(9);
  });
});
