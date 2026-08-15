import { describe, it, expect, vi } from "vitest";
import type { member } from "@dub/types";
import { runOffboard, type OffboardApi } from "../src/lib/offboard";
import type { OffboardUserResult } from "../src/contracts/pending";

const USER = { id: "user_bob", email: "bob@developershub.jp" };

function identityResult(): OffboardUserResult {
  return {
    user: { id: "user_bob", orgId: "o", displayName: "Bob", email: USER.email, githubLogin: null, avatarUrl: null, status: "disabled", roleIds: [], createdAt: "t", updatedAt: "t" },
    revokedAssignments: 1,
    alreadyDisabled: false,
    steps: [
      { step: "revoke-sessions", status: "done" },
      { step: "revoke-roles", status: "done", detail: "1" },
      { step: "disable-account", status: "done" },
    ],
  };
}

function member_(over: Partial<member.Member> = {}): member.Member {
  return { id: "member_bob", orgId: "o", name: "佐藤 太郎", roleTitle: null, status: "added", teamIds: [], identityUserId: "user_bob", contact: null, note: null, sortOrder: 1, version: 3, createdAt: "t", updatedAt: "t", ...over };
}

function fakeApi(over: Partial<OffboardApi> = {}): OffboardApi {
  return {
    offboardUser: vi.fn(async () => identityResult()),
    getMemberByIdentity: vi.fn(async () => ({ member: member_() })),
    patchMember: vi.fn(async () => member_({ status: "declined", version: 4 })),
    listEmailAddresses: vi.fn(async () => ({ items: [{ id: "eml_bob", localPart: "bob", address: "bob@developershub.jp", destination: "x@y.jp", enabled: true, createdAt: "t" }], nextCursor: null })),
    deleteEmailAddress: vi.fn(async () => {}),
    ...over,
  };
}

describe("runOffboard (#2 orchestration)", () => {
  it("does all three steps and reports success with the member's version", async () => {
    const api = fakeApi();
    const out = await runOffboard(api, USER);
    expect(out.ok).toBe(true);
    expect(out.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "identity:done",
      "member-status:done",
      "email-routing:done",
    ]);
    expect(api.patchMember).toHaveBeenCalledWith("member_bob", { status: "declined", version: 3 });
    expect(api.deleteEmailAddress).toHaveBeenCalledWith("eml_bob");
  });

  it("skips member + email steps cleanly when there is nothing to do", async () => {
    const api = fakeApi({
      getMemberByIdentity: vi.fn(async () => ({ member: null })),
      listEmailAddresses: vi.fn(async () => ({ items: [], nextCursor: null })),
    });
    const out = await runOffboard(api, USER);
    expect(out.ok).toBe(true);
    expect(out.steps.find((s) => s.step === "member-status")!.status).toBe("skipped");
    expect(out.steps.find((s) => s.step === "email-routing")!.status).toBe("skipped");
    expect(api.patchMember).not.toHaveBeenCalled();
    expect(api.deleteEmailAddress).not.toHaveBeenCalled();
  });

  it("partial success: a failed cross-step is recorded but never aborts the others", async () => {
    const api = fakeApi({ patchMember: vi.fn(async () => { throw { message: "boom" }; }) });
    const out = await runOffboard(api, USER);
    expect(out.ok).toBe(false);
    expect(out.steps.find((s) => s.step === "member-status")!.status).toBe("failed");
    // email step still ran despite the member failure.
    expect(out.steps.find((s) => s.step === "email-routing")!.status).toBe("done");
    expect(api.deleteEmailAddress).toHaveBeenCalled();
  });

  it("idempotent re-run: member already retired is skipped", async () => {
    const api = fakeApi({ getMemberByIdentity: vi.fn(async () => ({ member: member_({ status: "declined" }) })) });
    const out = await runOffboard(api, USER);
    expect(out.steps.find((s) => s.step === "member-status")!.detail).toBe("既に退任状態");
    expect(api.patchMember).not.toHaveBeenCalled();
  });

  it("fatal identity error propagates (nothing else runs)", async () => {
    const api = fakeApi({ offboardUser: vi.fn(async () => { throw new Error("LAST_ADMIN"); }) });
    await expect(runOffboard(api, USER)).rejects.toThrow("LAST_ADMIN");
    expect(api.getMemberByIdentity).not.toHaveBeenCalled();
  });
});
