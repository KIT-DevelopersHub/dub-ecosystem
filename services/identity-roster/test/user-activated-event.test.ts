// #850: invited -> active publishes identity.user.activated (chat-service creates the member's
// times channel in Dub chat). Best-effort sink; only on the transition, not on idempotent re-provision.
import { describe, expect, it } from "vitest";
import { MemIdentityRepo } from "../src/repo/mem-repo";
import { IdentityService } from "../src/service";
import { ORG_ID } from "./harness";

describe("identity.user.activated", () => {
  it("fires once on invited -> active with the member's email / name", async () => {
    const repo = new MemIdentityRepo();
    const seen: unknown[] = [];
    const svc = new IdentityService({
      repo,
      audit: { logSync: async () => {}, publish: async () => {} },
      revoker: { revokeUser: async () => {} },
      events: { userActivated: async (input) => void seen.push(input) },
      now: () => "2026-11-26T00:00:00.000Z",
      newId: (p: string) => `${p}_${seen.length}_${Math.random().toString(36).slice(2, 8)}`,
      defaultOrgId: ORG_ID,
    });
    const ctx = { requestId: "req_t", actorId: null };
    await repo.createUser({
      id: "usr_new",
      orgId: ORG_ID,
      email: "new@example.com",
      displayName: "New Member",
      githubLogin: null,
      avatarUrl: null,
      status: "invited",
      createdAt: "x",
      updatedAt: "x",
    } as never);
    expect((await svc.provision(ORG_ID, { email: "new@example.com", displayName: "New Member" }, ctx)).status).toBe("provisioned");
    expect(seen).toEqual([{ orgId: ORG_ID, userId: "usr_new", email: "new@example.com", displayName: "New Member" }]);
    await svc.provision(ORG_ID, { email: "new@example.com", displayName: "New Member" }, ctx);
    expect(seen).toHaveLength(1);
  });
});
