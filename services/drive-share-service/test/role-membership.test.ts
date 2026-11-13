// The identity-roster client behind カレンダー > ミーティング's role expansion. The point under
// test: every read works for the SYSTEM actor (the hourly MeetingSyncDO alarm builds the
// client with a requestId and no userId), which means hitting only the x-dub-internal
// routes — the key-gated /identity/roles 401s an actor-less call, and that is what kept
// deleted-role calendars shared in prod.
import { describe, it, expect } from "vitest";
import { createIdentityRoleMembership } from "../src/role-membership";
import { fakeIdentityBinding } from "./helpers";

const PEOPLE = {
  users: [
    { id: "usr_a", email: "A@dub.example ", name: "A", roleIds: ["role_dev"] },
    { id: "usr_b", email: "b@dub.example", name: "", roleIds: ["role_dev", "role_pr"] },
  ],
  roles: { role_dev: "開発", role_pr: "広報" },
};

describe("createIdentityRoleMembership as the system actor (no userId)", () => {
  it("listRoles reads /internal/roles with the marker and no user header", async () => {
    const { binding, calls } = fakeIdentityBinding(PEOPLE);
    const roster = createIdentityRoleMembership(binding, { requestId: "req_sys" });
    expect(await roster.listRoles()).toEqual([
      { id: "role_dev", name: "開発" },
      { id: "role_pr", name: "広報" },
    ]);
    expect(calls).toEqual([{ method: "GET", path: "/internal/roles", userId: null, internal: true }]);
  });

  it("roleName resolves off the same internal read (cached per instance)", async () => {
    const { binding, calls } = fakeIdentityBinding(PEOPLE);
    const roster = createIdentityRoleMembership(binding, { requestId: "req_sys" });
    expect(await roster.roleName("role_pr")).toBe("広報");
    expect(await roster.roleName("role_gone")).toBeNull();
    expect(await roster.listRoles()).toHaveLength(2);
    expect(calls.map((c) => c.path)).toEqual(["/internal/roles"]);
  });

  it("listActiveUsers / listActiveEmails stay on /internal/users and normalise addresses", async () => {
    const { binding, calls } = fakeIdentityBinding(PEOPLE);
    const roster = createIdentityRoleMembership(binding, { requestId: "req_sys" });
    expect(await roster.listActiveUsers("role_dev")).toEqual([
      { id: "usr_a", email: "a@dub.example", name: "A", roleIds: ["role_dev"] },
      { id: "usr_b", email: "b@dub.example", name: "b@dub.example", roleIds: ["role_dev", "role_pr"] },
    ]);
    expect(await roster.listActiveEmails("role_pr")).toEqual(["b@dub.example"]);
    expect(calls.every((c) => c.path === "/internal/users" && c.userId === null && c.internal)).toBe(true);
  });

  it("never touches the key-gated /identity/* surface, with or without an acting user", async () => {
    const { binding, calls } = fakeIdentityBinding(PEOPLE);
    const asUser = createIdentityRoleMembership(binding, { requestId: "req_1", userId: "usr_a" });
    await asUser.listRoles();
    await asUser.listActiveUsers();
    expect(calls.map((c) => c.path).every((p) => p.startsWith("/internal/"))).toBe(true);
    expect(calls[0]!.userId).toBe("usr_a"); // the acting user is still forwarded for attribution
  });
});
