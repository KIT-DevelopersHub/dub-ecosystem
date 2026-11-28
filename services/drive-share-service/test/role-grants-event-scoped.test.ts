// 運営ロールをイベント単位へ移した後 (団体全体の行が無く、イベント単位の行だけ) も、そのロールの
// Drive共有が付き・剥がれないこと。identity は roleIds (団体全体) と scopedRoleIds (イベント単位だけ) を分けて返す。
import { describe, it, expect } from "vitest";
import { createMockDriveShareClient } from "../src/mock-client";
import type { ActiveUser } from "../src/role-membership";
import { buildRoleGrants, fakeRoster } from "./helpers";

const ORGANIZER = "role_sys_organizer";
const users: ActiveUser[] = [
  { id: "u_org", email: "organizer@example.com", name: "Organizer", roleIds: ["role_sys_member"], scopedRoleIds: [ORGANIZER] },
  { id: "u_plain", email: "plain@example.com", name: "Plain", roleIds: ["role_sys_member"] },
];

async function emailsOn(drive: ReturnType<typeof createMockDriveShareClient>, fileId: string): Promise<string[]> {
  const { permissions } = await drive.listPermissions(fileId);
  return permissions.filter((p) => p.type === "user" && p.emailAddress).map((p) => p.emailAddress!.toLowerCase());
}

describe("Drive共有 counts roles held only per event", () => {
  it("shares a role grant with its per-event holders", async () => {
    const drive = createMockDriveShareClient();
    const { service } = buildRoleGrants({ drive, roster: fakeRoster({}, { [ORGANIZER]: "organizer" }, users) });
    const grant = await service.apply("fld_designs", "usr_admin", ORGANIZER, "writer");
    expect(grant.memberCount).toBe(1);
    expect(await emailsOn(drive, "fld_designs")).toContain("organizer@example.com");
    expect(await emailsOn(drive, "fld_designs")).not.toContain("plain@example.com");
  });

  it("does not unshare them when their membership is followed", async () => {
    const drive = createMockDriveShareClient();
    const { service } = buildRoleGrants({ drive, roster: fakeRoster({}, { [ORGANIZER]: "organizer" }, users) });
    await service.apply("fld_designs", "usr_admin", ORGANIZER, "writer");
    const res = await service.followRoles([ORGANIZER], "removed", { budgetMs: 10_000, maxWrites: 50 });
    expect(res.revoked).toBe(0);
    expect(res.held).toBe(0);
    expect(await emailsOn(drive, "fld_designs")).toContain("organizer@example.com");
    const plan = await service.planReconcile();
    expect(JSON.stringify(plan)).not.toContain("organizer@example.com");
  });
});
