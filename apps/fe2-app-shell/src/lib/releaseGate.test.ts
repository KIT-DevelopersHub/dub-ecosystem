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

  it("keeps ガント (gantt) admin-only: unpublished, so members are greyed and admins bypass", () => {
    // The task Gantt is an admin/dev-only app for now (社長方針「一旦adminだけ」). Being
    // absent from PUBLISHED_APPS is exactly what greys it for general members while
    // privileged viewers (admins/maintainers) bypass the gate — the release-gating
    // "app on/off" mechanism. Do NOT add "gantt" here without an explicit publish call.
    expect(isAppPublished("gantt")).toBe(false);
    expect(PUBLISHED_APPS.has("gantt")).toBe(false);
    // admin bypasses; a read-only member does not (tile greyed + route 403).
    expect(isPrivilegedViewer(canFrom(["identity:admin"]))).toBe(true);
    expect(isPrivilegedViewer(canFrom(["task:read", "event:read"]))).toBe(false);
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

  it("maintainer (holds *:admin / dangerous perms, but not identity:admin) is privileged", () => {
    const maintainer: PermissionKey[] = ["identity:read", "event:admin", "mail:admin", "chat:moderate"];
    expect(isPrivilegedViewer(canFrom(maintainer))).toBe(true);
  });

  it("a general member (read-only perms) is NOT privileged", () => {
    const member: PermissionKey[] = ["identity:read", "event:read", "task:read", "mail:read"];
    expect(isPrivilegedViewer(canFrom(member))).toBe(false);
  });

  it("a loading/unauthenticated viewer (fail-closed can) is NOT privileged", () => {
    expect(isPrivilegedViewer(() => false)).toBe(false);
  });
});
