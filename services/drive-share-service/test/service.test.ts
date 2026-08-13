import { describe, it, expect } from "vitest";
import { CommonErrorCodes } from "@dub/errors";
import { createDriveShareService } from "../src/service";
import { createMockDriveShareClient } from "../src/mock-client";

function svc() {
  return createDriveShareService({ client: createMockDriveShareClient(), config: { listPageSize: 50 } });
}

describe("service.listFiles", () => {
  it("clamps limit into [1,200] and passes the filter through", async () => {
    const s = svc();
    const res = await s.listFiles({ q: "予算", limit: 9999 });
    expect(res.files).toHaveLength(1);
    expect(res.files[0]!.name).toContain("予算");
  });
});

describe("service.grant", () => {
  it("rejects an invalid email", async () => {
    const s = svc();
    await expect(s.grant("fld_root", { emailAddress: "not-an-email", role: "reader" })).rejects.toMatchObject({
      code: CommonErrorCodes.VALIDATION_FAILED,
    });
  });

  it("rejects a non-assignable role (owner) at the boundary", async () => {
    const s = svc();
    await expect(
      // deliberately bypassing the TS Exclude to prove the runtime guard holds
      s.grant("fld_root", { emailAddress: "x@example.com", role: "owner" as "reader" }),
    ).rejects.toMatchObject({ code: CommonErrorCodes.VALIDATION_FAILED });
  });

  it("grants a valid reader", async () => {
    const s = svc();
    const p = await s.grant("fil_budget", { emailAddress: "volunteer@example.com", role: "commenter" });
    expect(p.role).toBe("commenter");
    expect(p.emailAddress).toBe("volunteer@example.com");
  });
});

describe("service.setLinkSharing", () => {
  it("enables link sharing by upserting the anyone permission", async () => {
    const s = svc();
    const before = await s.listPermissions("fil_budget");
    expect(before.permissions.some((p) => p.type === "anyone")).toBe(false);

    const after = await s.setLinkSharing("fil_budget", { enabled: true, role: "reader" });
    expect(after.permissions.filter((p) => p.type === "anyone")).toHaveLength(1);
  });

  it("disables link sharing idempotently (no anyone perm present)", async () => {
    const s = svc();
    const res = await s.setLinkSharing("fld_root", { enabled: false });
    expect(res.permissions.some((p) => p.type === "anyone")).toBe(false);
  });

  it("turns an existing link share off", async () => {
    const s = svc();
    const before = await s.listPermissions("fil_flyer");
    expect(before.permissions.some((p) => p.type === "anyone")).toBe(true);
    const after = await s.setLinkSharing("fil_flyer", { enabled: false });
    expect(after.permissions.some((p) => p.type === "anyone")).toBe(false);
  });
});

describe("service.updateRole / revoke", () => {
  it("changes then revokes a grant", async () => {
    const s = svc();
    const granted = await s.grant("fld_designs", { emailAddress: "temp@example.com", role: "reader" });
    const updated = await s.updateRole("fld_designs", granted.id, { role: "writer" });
    expect(updated.role).toBe("writer");
    await s.revoke("fld_designs", granted.id);
    const perms = await s.listPermissions("fld_designs");
    expect(perms.permissions.find((p) => p.id === granted.id)).toBeUndefined();
  });
});
