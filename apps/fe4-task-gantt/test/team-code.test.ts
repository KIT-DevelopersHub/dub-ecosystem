import { describe, it, expect } from "vitest";
import type { team } from "@dub/types";
import { CANONICAL_TEAMS, teamCode, teamCodeById } from "../src/domain/team-code";

const mkTeam = (key: string, name: string): team.Team => ({ id: key, key, name });

describe("teamCode — the 9 official teams each get their own code (regression for the all-AA bug)", () => {
  it.each(CANONICAL_TEAMS)("%s -> %s", ({ key, name, code }) => {
    expect(teamCode(mkTeam(key, name))).toBe(code);
  });

  it("resolves every one of the 9 teams to a DIFFERENT code (no collapsing to a shared default, incl. 開発=KH being independent from 統括=TK)", () => {
    const codes = CANONICAL_TEAMS.map((t) => teamCode(mkTeam(t.key, t.name)));
    expect(new Set(codes).size).toBe(CANONICAL_TEAMS.length);
    expect(codes).toEqual(["TK", "KH", "TU", "SP", "SE", "HK", "SK", "DS", "HM"]);
  });

  it("matches the EXACT prod team rows verbatim (member_teams, org_devhub, read 2026-09-16)", () => {
    expect(teamCode(mkTeam("exec", "統括チーム"))).toBe("TK");
    expect(teamCode(mkTeam("dev", "開発チーム"))).toBe("KH");
    expect(teamCode(mkTeam("ops", "当日運営チーム"))).toBe("TU");
    expect(teamCode(mkTeam("sponsor", "スポンサーチーム"))).toBe("SP");
    expect(teamCode(mkTeam("venue", "セッションチーム"))).toBe("SE");
    expect(teamCode(mkTeam("finance", "法務会計チーム"))).toBe("HK");
    expect(teamCode(mkTeam("pr", "集客広報チーム"))).toBe("SK");
    expect(teamCode(mkTeam("design", "デザインチーム"))).toBe("DS");
  });

  it("matches by name even without the prod \"チーム\" suffix, or with an opaque/random key (real prod teams slugify Japanese names to \"\")", () => {
    expect(teamCode(mkTeam("team-a1b2c3", "セッション"))).toBe("SE");
    expect(teamCode(mkTeam("team-x9y8z7", "当日運営"))).toBe("TU");
    expect(teamCode(mkTeam("team-q1w2e3", "開発"))).toBe("KH");
  });

  it("maps the pre-rename legacy NAMES to today's codes (会場→セッション, 当日進行→当日運営; the prod row kept its key — venue/ops — only the displayed name changed)", () => {
    expect(teamCode(mkTeam("venue", "会場"))).toBe("SE");
    expect(teamCode(mkTeam("ops", "当日進行"))).toBe("TU");
    expect(teamCode(mkTeam("some-other-key", "会場"))).toBe("SE");
    expect(teamCode(mkTeam("some-other-key", "当日進行"))).toBe("TU");
  });

  it("maps other historical (pre-taxonomy) legacy names/keys", () => {
    expect(teamCode(mkTeam("honbu", "本部"))).toBe("TK");
    expect(teamCode(mkTeam("kaikei", "会計"))).toBe("HK");
    expect(teamCode(mkTeam("shinko", "全体進行"))).toBe("TU");
    expect(teamCode(mkTeam("some-other-key", "集客告知"))).toBe("SK");
  });

  it("開発/dev is its OWN code (KH) — no longer folded into 統括(TK)", () => {
    expect(teamCode(mkTeam("dev", "開発"))).toBe("KH");
    expect(teamCode(mkTeam("dev", "開発チーム"))).toBe("KH");
    expect(teamCode(mkTeam("dev", "開発チーム"))).not.toBe("TK");
  });

  it("resolves fe2 demo-seed's exact team keys/names (soukatsu/dev/ops/sponsor/venue/pr, old \"…チーム\" names still in the fixture)", () => {
    expect(teamCode(mkTeam("soukatsu", "統括チーム"))).toBe("TK");
    expect(teamCode(mkTeam("dev", "開発チーム"))).toBe("KH");
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
    const teamsById = new Map([["t1", mkTeam("exec", "統括チーム")] as const]);
    expect(teamCodeById("t1", teamsById)).toBe("TK");
  });

  it("returns \"\" for a null teamId or a teamId missing from the map", () => {
    const teamsById = new Map<string, team.Team>();
    expect(teamCodeById(null, teamsById)).toBe("");
    expect(teamCodeById("missing", teamsById)).toBe("");
  });
});
