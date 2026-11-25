// Role sharing goes to each member's 名簿 Gmail (a Google account), not their Dub login address:
// login addresses such as Cloudflare Email-Routing aliases have no Google account and Drive
// refuses them outright (403 cannotInviteNonGoogleUser).
import { describe, it, expect } from "vitest";
import { errors } from "@dub/errors";
import { createMockDriveShareClient } from "../src/mock-client";
import { NON_GOOGLE_USER_JA, type DriveShareClient } from "../src/drive-client";
import { staticMemberDirectory } from "../src/member-directory";
import { buildRoleGrants, fakeRoster } from "./helpers";

const FILE = "fld_designs"; // owner only

/** Drive that, like the real one, refuses every @developershub.jp address (no Google account). */
function nonGoogleRefusing(inner: DriveShareClient): DriveShareClient {
  return {
    ...inner,
    listFiles: (p) => inner.listFiles(p),
    listPermissions: (id) => inner.listPermissions(id),
    updatePermission: (f, id, r) => inner.updatePermission(f, id, r),
    deletePermission: (f, id) => inner.deletePermission(f, id),
    async createPermission(fileId, p) {
      if (p.emailAddress?.endsWith("@developershub.jp")) throw errors.forbidden(NON_GOOGLE_USER_JA);
      return inner.createPermission(fileId, p);
    },
  };
}

const roster = () =>
  fakeRoster({ role_dev: ["makoto@developershub.jp", "ren@developershub.jp"] }, { role_dev: "開発" });
// makoto has a 名簿 Gmail; ren does not.
const directory = staticMemberDirectory({ "usr:makoto@developershub.jp": { gmail: "makoto.y@gmail.com", name: "誠" } });

describe("role sharing uses the 名簿 Gmail", () => {
  it("shares at the Gmail and explains how to fix a member without one", async () => {
    const drive = nonGoogleRefusing(createMockDriveShareClient());
    const { service } = buildRoleGrants({ drive, roster: roster(), directory });

    const grant = await service.apply(FILE, "usr_admin", "role_dev", "writer");

    expect(grant.memberCount).toBe(2);
    expect(grant.appliedCount).toBe(1);
    const emails = (await drive.listPermissions(FILE)).permissions.map((p) => p.emailAddress);
    expect(emails).toContain("makoto.y@gmail.com");
    expect(emails).not.toContain("makoto@developershub.jp");
    expect(grant.skipped).toEqual([{ email: "ren@developershub.jp", reason: expect.stringContaining("名簿にこのメンバーの Gmail を登録") }]);
  });

  it("reapply moves a member from the login address to the Gmail once it is registered", async () => {
    const drive = createMockDriveShareClient(); // accepts anything (e.g. an old pending invite)
    const before = buildRoleGrants({ drive, roster: roster() });
    await before.service.apply(FILE, "usr_admin", "role_dev", "reader");
    const store = before.store;

    const { service } = buildRoleGrants({ drive, roster: roster(), directory, store });
    await service.reapply(FILE, "role_dev");

    const emails = (await drive.listPermissions(FILE)).permissions.map((p) => p.emailAddress);
    expect(emails).toContain("makoto.y@gmail.com");
    expect(emails).not.toContain("makoto@developershub.jp"); // our old share removed
    expect(emails).toContain("ren@developershub.jp"); // no Gmail yet → unchanged
  });

  it("drift compares against the Gmail, so a Gmail share is not reported as outside the role", async () => {
    const drive = nonGoogleRefusing(createMockDriveShareClient());
    const { service } = buildRoleGrants({ drive, roster: roster(), directory });
    await service.apply(FILE, "usr_admin", "role_dev", "writer");

    const d = await service.drift(FILE);
    expect(d.matchedCount).toBe(1);
    expect(d.items.map((i) => [i.kind, i.email])).toEqual([["missing", "ren@developershub.jp"]]);
  });
});
