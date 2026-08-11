// rosterApi ↔ mock-client contract for admin password management (#5a set/re-issue,
// #5c view). Mirrors the gateway/auth-service behaviour: a generated password is
// returned once and becomes viewable; a specified one returns { ok } only; view before
// any credential exists rejects like the backend's PASSWORD_NOT_VIEWABLE.
import { describe, it, expect } from "vitest";
import { isErrorResponse } from "@dub/errors";
import { createMockClient } from "../src/api/mockClient";
import { createRosterApi } from "../src/api/rosterApi";

function api() {
  return createRosterApi(createMockClient());
}

describe("rosterApi password management (#5a/#5c)", () => {
  it("generate returns a one-time password that then becomes viewable", async () => {
    const a = api();
    const res = await a.setUserPassword("user_bob", { generate: true });
    expect(res.ok).toBe(true);
    expect(typeof res.password).toBe("string");
    expect(res.password!.length).toBeGreaterThanOrEqual(8);
    const view = await a.viewUserPassword("user_bob");
    expect(view.password).toBe(res.password);
    expect(view.userId).toBe("user_bob");
  });

  it("specify returns { ok } without a password and stores it", async () => {
    const a = api();
    const res = await a.setUserPassword("user_bob", { password: "Specified-12345" });
    expect(res.ok).toBe(true);
    expect(res.password).toBeUndefined();
    expect((await a.viewUserPassword("user_bob")).password).toBe("Specified-12345");
  });

  it("a too-short specified password rejects VALIDATION_FAILED", async () => {
    await expect(api().setUserPassword("user_bob", { password: "short" })).rejects.toSatisfy(
      (e) => isErrorResponse(e) && e.error.code === "VALIDATION_FAILED",
    );
  });

  it("view without a credential rejects PASSWORD_NOT_VIEWABLE", async () => {
    await expect(api().viewUserPassword("user_bob")).rejects.toSatisfy(
      (e) => isErrorResponse(e) && e.error.code === "PASSWORD_NOT_VIEWABLE",
    );
  });

  it("view a seeded user returns its current password + email", async () => {
    const view = await api().viewUserPassword("user_alice");
    expect(view.password).toBe("Alice-Init-0001");
    expect(view.email).toContain("@");
  });
});
