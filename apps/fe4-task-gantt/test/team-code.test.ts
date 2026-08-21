import { describe, it, expect } from "vitest";
import type { team, common } from "@dub/types";
import { CANONICAL_TEAMS, teamCode, teamCodeById } from "../src/domain/team-code";

const mk = (partial: Partial<team.Team> & { key: string; name: string }): team.Team => ({
  id: `team_${partial.key}`,
  color: "#000",
  ...partial,
});

describe("team-code — canonical taxonomy", () => {
  it("has the 8 official teams with their contractual 2-letter codes", () => {
    const map = Object.fromEntries(CANONICAL_TEAMS.map((t) => [t.name, t.code]));
    expect(map).toEqual({
      統括: "TK",
      法務会計: "HK",
      会場: "KJ",
      当日進行: "TS",
      スポンサー: "SP",
      集客広報: "SK",
      デザイン: "DS",
      法人メンバー: "HJ",
    });
  });

  it("all codes are unique", () => {
    const codes = CANONICAL_TEAMS.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("teamCode — resolver", () => {
  it("resolves a canonical team by key", () => {
    expect(teamCode(mk({ key: "toukatsu", name: "統括" }))).toBe("TK");
    expect(teamCode(mk({ key: "houjin", name: "法人メンバー" }))).toBe("HJ");
  });

  it("prefers an explicit code on the team", () => {
    expect(teamCode(mk({ key: "whatever", name: "?", code: "zz" }))).toBe("ZZ");
  });

  it("maps legacy team names/keys onto the new codes", () => {
    expect(teamCode(mk({ key: "honbu", name: "本部" }))).toBe("TK");
    expect(teamCode(mk({ key: "kaikei", name: "会計" }))).toBe("HK");
    expect(teamCode(mk({ key: "shinko", name: "全体進行" }))).toBe("TS");
    expect(teamCode(mk({ key: "pr", name: "集客告知" }))).toBe("SK");
  });

  it("falls back to the first two ASCII letters of an unknown key", () => {
    expect(teamCode(mk({ key: "growth", name: "グロース" }))).toBe("GR");
  });

  it("returns '' for a null team or one with no usable code", () => {
    expect(teamCode(null)).toBe("");
    expect(teamCode(mk({ key: "各", name: "各" }))).toBe("");
  });
});

describe("teamCodeById", () => {
  it("looks a team up by id then resolves its code", () => {
    const teams = new Map<common.TeamId, team.Team>([
      ["team_toukatsu", mk({ key: "toukatsu", name: "統括" })],
    ]);
    expect(teamCodeById("team_toukatsu", teams)).toBe("TK");
    expect(teamCodeById("missing", teams)).toBe("");
    expect(teamCodeById(null, teams)).toBe("");
  });
});
