import { describe, expect, it } from "vitest";
import { buildPdfFromJpegs, buildRosterTable, crc32, toCsv, toXlsx } from "./rosterExport.ts";
import type { MemberTeam, OrgMember } from "./contracts.ts";

const member = (over: Partial<OrgMember>): OrgMember =>
  ({
    id: "m1",
    name: "山田 太郎",
    lastNameKana: "やまだ",
    firstNameKana: "たろう",
    status: "added",
    teamIds: ["t1"],
    leaderId: null,
    identityUserId: "u1",
    version: 1,
    ...over,
  }) as OrgMember;

const ctx = {
  teamsById: new Map([["t1", { id: "t1", name: "広報" } as MemberTeam]]),
  accountLabels: new Map([["u1", "yamada@developershub.jp"]]),
  leaderNames: new Map<string, string>(),
};

const text = (b: Uint8Array): string => new TextDecoder("latin1").decode(b);

describe("rosterExport", () => {
  it("builds one row per member with resolved team/account labels", () => {
    const t = buildRosterTable([member({})], ctx);
    expect(t.headers).toHaveLength(13);
    expect(t.rows[0]).toEqual(expect.arrayContaining(["山田 太郎", "やまだ たろう", "広報", "yamada@developershub.jp"]));
    expect(t.rows[0]).toHaveLength(13);
  });

  it("CSV has a BOM, quotes special chars and neutralizes formulas but keeps phone numbers", () => {
    const csv = toCsv({ headers: ["a", "b", "c"], rows: [['x,"y"', "=SUM(A1)", "+81-90-0000-0000"]] });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"x,""y"""');
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain(",+81-90-0000-0000\r\n");
  });

  it("xlsx is a zip whose sheet contains escaped cell text", () => {
    const z = toXlsx({ headers: ["氏名"], rows: [["A&B <c>"]] });
    expect(new DataView(z.buffer).getUint32(0, true)).toBe(0x04034b50);
    const raw = new TextDecoder().decode(z);
    expect(raw).toContain("xl/worksheets/sheet1.xml");
    expect(raw).toContain("A&amp;B &lt;c&gt;");
  });

  it("crc32 matches the reference value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("PDF has one page per image and a valid xref offset", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = buildPdfFromJpegs([
      { jpeg, pxWidth: 10, pxHeight: 7 },
      { jpeg, pxWidth: 10, pxHeight: 7 },
    ]);
    const s = text(pdf);
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s).toContain("/Count 2");
    const startxref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(startxref, startxref + 4)).toBe("xref");
    // every xref entry points at its "N 0 obj" header
    const entries = s.slice(startxref).split("\n").slice(3, 3 + 7);
    entries.forEach((e, i) => expect(s.slice(Number(e.slice(0, 10)))).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
});
