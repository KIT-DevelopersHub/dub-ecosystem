import { describe, it, expect } from "vitest";
import { CommonErrorCodes } from "@dub/errors";
import { createMockDriveShareClient } from "../src/mock-client";

describe("mock drive client", () => {
  it("lists seeded files folder-first with the link-share hint", async () => {
    const c = createMockDriveShareClient();
    const { files, nextCursor } = await c.listFiles({ pageSize: 50 });
    expect(files.length).toBeGreaterThan(0);
    expect(nextCursor).toBeNull();
    // folders sort before files
    const firstNonFolder = files.findIndex((f) => !f.isFolder);
    const lastFolder = files.map((f) => f.isFolder).lastIndexOf(true);
    expect(lastFolder).toBeLessThan(firstNonFolder);
    // the flyer is seeded with an anyone permission
    const flyer = files.find((f) => f.id === "fil_flyer");
    expect(flyer?.linkShared).toBe(true);
    const budget = files.find((f) => f.id === "fil_budget");
    expect(budget?.linkShared).toBe(false);
  });

  it("name filter is case-insensitive substring", async () => {
    const c = createMockDriveShareClient();
    const { files } = await c.listFiles({ pageSize: 50, q: "予算" });
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe("fil_budget");
  });

  it("lists only root-level entries when no folderId is given", async () => {
    const c = createMockDriveShareClient();
    const { files } = await c.listFiles({ pageSize: 50 });
    const ids = files.map((f) => f.id);
    // the five root seeds are present …
    expect(ids).toEqual(expect.arrayContaining(["fld_root", "fld_designs", "fil_budget", "fil_flyer", "fil_runsheet"]));
    // … and NO deeper children leak into the root listing.
    expect(ids).not.toContain("fld_sponsors");
    expect(ids).not.toContain("fil_contract");
  });

  it("folderId returns exactly the direct children (folder-first)", async () => {
    const c = createMockDriveShareClient();
    const { files } = await c.listFiles({ pageSize: 50, folderId: "fld_root" });
    expect(files.map((f) => f.id)).toEqual(["fld_sponsors", "fil_schedule"]);
    // folder before file
    expect(files[0]!.isFolder).toBe(true);
    expect(files[1]!.isFolder).toBe(false);
  });

  it("supports nesting deeper than one level", async () => {
    const c = createMockDriveShareClient();
    const { files } = await c.listFiles({ pageSize: 50, folderId: "fld_sponsors" });
    expect(files.map((f) => f.id).sort()).toEqual(["fil_contract", "fil_sponsor_deck"]);
  });

  it("returns an empty child set for a leaf folder", async () => {
    const c = createMockDriveShareClient();
    const { files } = await c.listFiles({ pageSize: 50, folderId: "fld_banners" });
    expect(files.map((f) => f.id)).toEqual(["fil_web_banner"]);
    const empty = await c.listFiles({ pageSize: 50, folderId: "fil_web_banner" });
    expect(empty.files).toHaveLength(0);
  });

  it("search ignores the parent constraint (flat fallback across all depths)", async () => {
    const c = createMockDriveShareClient();
    // 協賛 matches a depth-2 file even though we pass no folderId.
    const { files } = await c.listFiles({ pageSize: 50, q: "協賛" });
    expect(files.map((f) => f.id).sort()).toEqual(["fil_contract", "fil_sponsor_deck"]);
  });

  it("lists permissions for a file and 404s an unknown file", async () => {
    const c = createMockDriveShareClient();
    const { permissions } = await c.listPermissions("fld_root");
    expect(permissions.some((p) => p.role === "owner")).toBe(true);
    await expect(c.listPermissions("nope")).rejects.toMatchObject({ code: CommonErrorCodes.NOT_FOUND });
  });

  it("grants, updates and revokes a user permission (idempotent delete)", async () => {
    const c = createMockDriveShareClient();
    const created = await c.createPermission("fld_root", { type: "user", role: "reader", emailAddress: "new@example.com" });
    expect(created.emailAddress).toBe("new@example.com");
    expect(created.role).toBe("reader");

    const updated = await c.updatePermission("fld_root", created.id, "writer");
    expect(updated.role).toBe("writer");

    await c.deletePermission("fld_root", created.id);
    const after = await c.listPermissions("fld_root");
    expect(after.permissions.find((p) => p.id === created.id)).toBeUndefined();
    // deleting again is a no-op
    await expect(c.deletePermission("fld_root", created.id)).resolves.toBeUndefined();
  });

  it("rejects a duplicate grant to the same email", async () => {
    const c = createMockDriveShareClient();
    await expect(
      c.createPermission("fld_root", { type: "user", role: "writer", emailAddress: "staff-a@example.com" }),
    ).rejects.toMatchObject({ code: CommonErrorCodes.CONFLICT });
  });

  it("upserts the single anyone permission and refuses to touch owner", async () => {
    const c = createMockDriveShareClient();
    const a1 = await c.createPermission("fld_root", { type: "anyone", role: "reader" });
    const a2 = await c.createPermission("fld_root", { type: "anyone", role: "writer" });
    expect(a1.id).toBe(a2.id); // same anyone permission, role changed
    const perms = await c.listPermissions("fld_root");
    expect(perms.permissions.filter((p) => p.type === "anyone")).toHaveLength(1);

    const owner = perms.permissions.find((p) => p.role === "owner")!;
    await expect(c.updatePermission("fld_root", owner.id, "reader")).rejects.toMatchObject({
      code: CommonErrorCodes.FORBIDDEN,
    });
    await expect(c.deletePermission("fld_root", owner.id)).rejects.toMatchObject({
      code: CommonErrorCodes.FORBIDDEN,
    });
  });
});
