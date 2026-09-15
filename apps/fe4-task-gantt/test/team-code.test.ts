import { describe, it, expect } from "vitest";
import type { team } from "@dub/types";
import { CANONICAL_TEAMS, teamCode, teamCodeById } from "../src/domain/team-code";

const mkTeam = (key: string, name: string): team.Team => ({ id: key, key, name });

describe("teamCode — the 8 official teams each get their own code (regression for the all-AA bug)", () => {
  it.each(CANONICAL_TEAMS)("%s -> %s", ({ key, name, code }) => {
    expect(teamCode(mkTeam(key, name))).toBe(code);
  });

  it("resolves every one of the 8 teams to a DIFFERENT code (no collapsing to a shared default)", () => {
    const codes = CANONICAL_TEAMS.map((t) => teamCode(mkTeam(t.key, t.name)));
    expect(new Set(codes).size).toBe(CANONICAL_TEAMS.length);
    expect(codes).toEqual(["TK", "HK", "SE", "TU", "SP", "SK", "DS", "HM"]);
  });

  it("matches by name even when the stored key is an opaque/random slug (real prod teams slugify Japanese names to \"\")", () => {
    expect(teamCode(mkTeam("team-a1b2c3", "セッション"))).toBe("SE");
    expect(teamCode(mkTeam("team-x9y8z7", "当日運営"))).toBe("TU");
  });

  it("maps the pre-rename legacy names to today's codes (会場→セッション, 当日進行→当日運営)", () => {
    expect(teamCode(mkTeam("venue", "会場"))).toBe("SE");
    expect(teamCode(mkTeam("toujitsu", "当日進行"))).toBe("TU");
  });

  it("maps other historical legacy names/keys", () => {
    expect(teamCode(mkTeam("honbu", "本部"))).toBe("TK");
    expect(teamCode(mkTeam("dev", "開発"))).toBe("TK");
    expect(teamCode(mkTeam("kaikei", "会計"))).toBe("HK");
    expect(teamCode(mkTeam("shinko", "全体進行"))).toBe("TU");
    expect(teamCode(mkTeam("pr", "集客告知"))).toBe("SK");
  });

  it("resolves fe2 demo-seed's exact team keys/names (soukatsu/dev/ops/sponsor/venue/pr, \"…チーム\" suffix)", () => {
    expect(teamCode(mkTeam("soukatsu", "統括チーム"))).toBe("TK");
    expect(teamCode(mkTeam("dev", "開発チーム"))).toBe("TK");
    expect(teamCode(mkTeam("ops", "当日進行チーム"))).toBe("TU");
    expect(teamCode(mkTeam("sponsor", "スポンサーチーム"))).toBe("SP");
    expect(teamCode(mkTeam("venue", "会場チーム"))).toBe("SE");
    expect(teamCode(mkTeam("pr", "集客広報チーム"))).toBe("SK");
  });

  it("returns \"\" for null/undefined/unrecognized teams (numbering falls back to a bare number)", () => {
    expect(teamCode(null)).toBe("");
    expect(teamCode(undefined)).toBe("");
    expect(teamCode(mkTeam("team-unknown", "謎のチーム"))).toBe("");
  });
});

describe("teamCodeById", () => {
  it("resolves a code by teamId via the given lookup map", () => {
    const teamsById = new Map([["t1", mkTeam("toukatsu", "統括")] as const]);
    expect(teamCodeById("t1", teamsById)).toBe("TK");
  });

  it("returns \"\" for a null teamId or a teamId missing from the map", () => {
    const teamsById = new Map<string, team.Team>();
    expect(teamCodeById(null, teamsById)).toBe("");
    expect(teamCodeById("missing", teamsById)).toBe("");
  });
});
