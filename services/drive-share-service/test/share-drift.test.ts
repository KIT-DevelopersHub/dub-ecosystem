// Drift between role grants and actual Drive sharing: the pure rules, then the service
// wiring against the mock Drive + a fake roster.
import { describe, it, expect } from "vitest";
import { computeShareDrift } from "../src/share-drift";
import { createMockDriveShareClient } from "../src/mock-client";
import { buildRoleGrants, fakeRoster } from "./helpers";
import type { SharePermission } from "../src/types";

const perm = (over: Partial<SharePermission> & Pick<SharePermission, "id">): SharePermission => ({
  type: "user",
  role: "reader",
  emailAddress: null,
  displayName: null,
  domain: null,
  inherited: false,
  ...over,
});
const OWNER = perm({ id: "p_owner", role: "owner", emailAddress: "hackit@gmail.com" });

describe("computeShareDrift", () => {
  it("reports every direct share of a file with no role grant, but not the owner or inherited ones", () => {
    const d = computeShareDrift("f", [], [
      OWNER,
      perm({ id: "p1", emailAddress: "x@example.com", role: "writer" }),
      perm({ id: "p_link", type: "anyone" }),
      perm({ id: "p_inh", emailAddress: "parent@example.com", inherited: true }),
    ]);
    expect(d).toMatchObject({ grantCount: 0, expectedCount: 0, matchedCount: 0 });
    expect(d.items.map((i) => [i.kind, i.permissionId])).toEqual([
      ["unexpected", "p1"],
      ["unexpected", "p_link"],
    ]);
  });

  it("has nothing to report on an unshared file with no role grant", () => {
    expect(computeShareDrift("f", [], [OWNER]).items).toEqual([]);
  });

  it("reports shares outside the roles, wrong roles and members without access", () => {
    const d = computeShareDrift(
      "f",
      [{ roleName: "開発", driveRole: "writer", emails: ["a@x.jp", "b@x.jp", "c@x.jp", "d@x.jp"] }],
      [
        OWNER,
        perm({ id: "p_a", emailAddress: "A@x.jp", role: "writer" }), // matches (case-insensitive)
        perm({ id: "p_b", emailAddress: "b@x.jp", role: "reader" }), // weaker than granted
        perm({ id: "p_c", emailAddress: "c@x.jp", role: "writer" }),
        perm({ id: "p_out", emailAddress: "outsider@gmail.com", role: "writer" }),
        perm({ id: "p_link", type: "anyone", role: "reader" }),
        perm({ id: "p_dom", type: "domain", domain: "example.com" }),
      ],
    );
    expect(d.grantCount).toBe(1);
    expect(d.expectedCount).toBe(4);
    expect(d.matchedCount).toBe(2);
    expect(d.items.map((i) => [i.kind, i.permissionId ?? i.email])).toEqual([
      ["insufficient_role", "p_b"],
      ["unexpected", "p_out"],
      ["unexpected", "p_link"],
      ["unexpected", "p_dom"],
      ["missing", "d@x.jp"],
    ]);
    expect(d.items[0]).toMatchObject({ actualRole: "reader", expectedRole: "writer", roleNames: ["開発"] });
  });

  it("flags a stronger role than any grant, taking the strongest grant per member", () => {
    const d = computeShareDrift(
      "f",
      [
        { roleName: "会場", driveRole: "reader", emails: ["a@x.jp", "b@x.jp"] },
        { roleName: "広報", driveRole: "commenter", emails: ["a@x.jp"] },
      ],
      [perm({ id: "p_a", emailAddress: "a@x.jp", role: "commenter" }), perm({ id: "p_b", emailAddress: "b@x.jp", role: "writer" })],
    );
    expect(d.expectedCount).toBe(2);
    expect(d.matchedCount).toBe(1);
    expect(d.items).toEqual([
      expect.objectContaining({ kind: "excess_role", permissionId: "p_b", actualRole: "writer", expectedRole: "reader", roleNames: ["会場"] }),
    ]);
  });

  it("leaves inherited extra/stronger access to the parent folder but reports a weaker one", () => {
    const d = computeShareDrift(
      "f",
      [{ roleName: "開発", driveRole: "commenter", emails: ["a@x.jp", "b@x.jp", "c@x.jp"] }],
      [
        perm({ id: "p_inh_out", emailAddress: "staff@x.jp", role: "writer", inherited: true }),
        perm({ id: "p_inh_link", type: "anyone", inherited: true }),
        perm({ id: "p_inh_a", emailAddress: "a@x.jp", role: "writer", inherited: true }),
        perm({ id: "p_inh_b", emailAddress: "b@x.jp", role: "reader", inherited: true }),
        perm({ id: "p_inh_c", emailAddress: "c@x.jp", role: "commenter", inherited: true }),
      ],
    );
    expect(d.matchedCount).toBe(2);
    expect(d.items.map((i) => [i.kind, i.permissionId])).toEqual([["insufficient_role", "p_inh_b"]]);
  });
});

describe("RoleGrantsService.drift", () => {
  it("compares the file's grants (expanded to members) with Drive", async () => {
    const drive = createMockDriveShareClient();
    // fil_budget is seeded with owner + sponsor@example.com (reader, an individual share).
    const roster = fakeRoster({ role_dev: ["dev1@example.com", "dev2@example.com"] }, { role_dev: "開発" });
    const { service } = buildRoleGrants({ drive, roster });

    expect((await service.drift("fil_budget")).grantCount).toBe(0);

    await service.apply("fil_budget", "usr_admin", "role_dev", "writer");
    const clean = await service.drift("fil_budget");
    expect(clean).toMatchObject({ grantCount: 1, expectedCount: 2, matchedCount: 2 });
    expect(clean.items).toEqual([expect.objectContaining({ kind: "unexpected", email: "sponsor@example.com", actualRole: "reader" })]);

    // Someone shares by hand in Drive and changes a member's role behind the manager's back.
    await drive.createPermission("fil_budget", { type: "anyone", role: "reader" });
    const dev2 = (await drive.listPermissions("fil_budget")).permissions.find((p) => p.emailAddress === "dev2@example.com")!;
    await drive.deletePermission("fil_budget", dev2.id);

    const drifted = await service.drift("fil_budget");
    expect(drifted.matchedCount).toBe(1);
    expect(drifted.items.map((i) => [i.kind, i.granteeType, i.email])).toEqual([
      ["unexpected", "user", "sponsor@example.com"],
      ["unexpected", "anyone", null],
      ["missing", "user", "dev2@example.com"],
    ]);
    expect(drifted.items[2]!.roleNames).toEqual(["開発"]);
  });

  it("still reports what stays behind after the last role is removed", async () => {
    const drive = createMockDriveShareClient();
    // sponsor@ holds an individual share and is also a member, so 解除 must not touch it.
    const roster = fakeRoster({ role_dev: ["sponsor@example.com", "dev1@example.com"] }, { role_dev: "開発" });
    const { service } = buildRoleGrants({ drive, roster });
    await service.apply("fil_budget", "usr_admin", "role_dev", "writer");

    await service.revoke("fil_budget", "role_dev");

    const d = await service.drift("fil_budget");
    expect(d.grantCount).toBe(0);
    expect(d.items.map((i) => [i.kind, i.email])).toEqual([["unexpected", "sponsor@example.com"]]);
  });
});
