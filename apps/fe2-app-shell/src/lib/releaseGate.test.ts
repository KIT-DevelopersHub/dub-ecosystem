import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { isAppPublished, isPrivilegedViewer, PUBLISHED_APPS, UNPUBLISHED_TILE_REASON } from "./releaseGate.ts";

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

  it("maintainer (dangerous perms but NOT identity:admin) is NOT privileged -> gated", () => {
    // Regression: keying the bypass off any `dangerous` permission let non-admin
    // operator roles skip the gate and see every app active (the reported bug). Only
    // identity:admin bypasses now, so a maintainer is release-gated like a member.
    const maintainer: PermissionKey[] = ["identity:read", "event:admin", "mail:send", "chat:moderate", "infra:deploy"];
    expect(isPrivilegedViewer(canFrom(maintainer))).toBe(false);
  });

  it("organizer (holds event:admin, a dangerous perm, but not identity:admin) is NOT privileged", () => {
    const organizer: PermissionKey[] = ["identity:read", "event:read", "event:write", "event:admin", "task:write"];
    expect(isPrivilegedViewer(canFrom(organizer))).toBe(false);
  });

  it("a general member (read-only perms) is NOT privileged", () => {
    const member: PermissionKey[] = ["identity:read", "event:read", "task:read", "mail:read"];
    expect(isPrivilegedViewer(canFrom(member))).toBe(false);
  });

  it("a loading/unauthenticated viewer (fail-closed can) is NOT privileged", () => {
    expect(isPrivilegedViewer(() => false)).toBe(false);
  });
});
