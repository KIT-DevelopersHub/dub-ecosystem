import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { rankIdentityCandidates, scoreMatch } from "./identityMatch.ts";

function user(id: string, displayName: string, email: string, githubLogin: string | null = null): identity.IdentityUser {
  return { id, orgId: "o", displayName, email, githubLogin, avatarUrl: null, status: "active", roleIds: [], createdAt: "t", updatedAt: "t" };
}

describe("identity-link candidate matching (#1)", () => {
  it("scores exact name (ignoring spaces) highest, email local-part next", () => {
    const u = user("u1", "山田 太郎", "yamada@developershub.jp");
    expect(scoreMatch("山田太郎", u)).toBe(100); // spaces collapsed, exact display name
    expect(scoreMatch("yamada", u)).toBe(100); // exact match on email local-part
    expect(scoreMatch("yama", u)).toBe(60); // partial (contained in local-part)
    expect(scoreMatch("まったく別", u)).toBe(0);
  });

  it("ranks the likely match first and marks taken accounts", () => {
    const users = [
      user("u_other", "佐藤 花子", "hanako@developershub.jp"),
      user("u_match", "山田 太郎", "yamada@developershub.jp"),
      user("u_taken", "山田 次郎", "jiro@developershub.jp"),
    ];
    const ranked = rankIdentityCandidates("山田太郎", users, new Set(["u_taken"]));
    expect(ranked[0]!.user.id).toBe("u_match");
    expect(ranked[0]!.score).toBe(100);
    expect(ranked.find((c) => c.user.id === "u_taken")!.taken).toBe(true);
    expect(ranked.find((c) => c.user.id === "u_other")!.score).toBe(0);
  });

  it("empty member name yields no signal (score 0 for all)", () => {
    const ranked = rankIdentityCandidates("", [user("u1", "A", "a@x.jp")], new Set());
    expect(ranked.every((c) => c.score === 0)).toBe(true);
  });
});
