import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { isAppPublished, isPrivilegedViewer, isReleaseGatedFor, hasExplicitAppAccess, PUBLISHED_APPS, UNPUBLISHED_TILE_REASON } from "./releaseGate.ts";

type PermissionKey = identity.PermissionKey;

/** Build a fail-closed `can` from a permission list (mirrors AuthProvider.can). */
function canFrom(perms: PermissionKey[]): (p: PermissionKey) => boolean {
  const set = new Set<string>(perms);
  return (p) => set.has(p);
}

describe("releaseGate", () => {
  it("publishes only メール (mail) to general members as of 2026-08-14", () => {
    expect([...PUBLISHED_APPS]).toEqual(["mail"]);
    expect(isAppPublished("mail")).toBe(true);
    expect(isAppPublished("events")).toBe(false);
    expect(isAppPublished("admin")).toBe(false);
  });

  it("treats an unknown/undefined appId as published (never greys test fixtures)", () => {
    expect(isAppPublished(undefined)).toBe(true);
  });

  it("exposes the member tooltip text", () => {
    expect(UNPUBLISHED_TILE_REASON).toContain("メンバー未公開");
  });

  it("admin (identity:admin) is privileged -> bypasses the gate", () => {
    expect(isPrivilegedViewer(canFrom(["identity:admin"]))).toBe(true);
  });

  it("maintainer/organizer (holds *:admin dangerous perms, but NOT identity:admin) is NOT privileged (#255 admin-only bypass)", () => {
    const maintainer: PermissionKey[] = ["identity:read", "event:admin", "mail:admin", "chat:moderate"];
    expect(isPrivilegedViewer(canFrom(maintainer))).toBe(false);
  });

  it("a general member (read-only perms) is NOT privileged", () => {
    const member: PermissionKey[] = ["identity:read", "event:read", "task:read", "mail:read"];
    expect(isPrivilegedViewer(canFrom(member))).toBe(false);
  });

  it("a loading/unauthenticated viewer (fail-closed can) is NOT privileged", () => {
    expect(isPrivilegedViewer(() => false)).toBe(false);
  });

  // BUGFIX (#270 follow-up): an explicit per-app grant (app:<id>:view) overrides the
  // member-publish gate, so a granted non-admin can actually use the app.
  describe("isReleaseGatedFor — per-app grant overrides member-publish", () => {
    it("greys an unpublished app for a non-admin WITHOUT the grant", () => {
      const member = canFrom(["identity:read", "event:read"]);
      expect(isReleaseGatedFor("events", member)).toBe(true);
    });

    it("RELEASES an unpublished app to a non-admin WITH the per-app grant (the bug)", () => {
      const granted = canFrom(["identity:read", "event:read", "app:events:view"]);
      expect(hasExplicitAppAccess("events", granted)).toBe(true);
      expect(isReleaseGatedFor("events", granted)).toBe(false);
    });

    it("still greys the app once the grant is revoked (OFF)", () => {
      const revoked = canFrom(["identity:read", "event:read"]);
      expect(isReleaseGatedFor("events", revoked)).toBe(true);
    });

    it("member-published app (mail) is never release-gated regardless of grant", () => {
      expect(isReleaseGatedFor("mail", canFrom(["mail:read"]))).toBe(false);
    });

    it("admin bypasses the gate for every app", () => {
      expect(isReleaseGatedFor("events", canFrom(["identity:admin"]))).toBe(false);
    });

    it("fail-closed while loading: no grant, not admin -> gated", () => {
      expect(isReleaseGatedFor("events", () => false)).toBe(true);
    });
  });
});
