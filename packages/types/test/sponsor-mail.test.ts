// スポンサーのメール連携: 照合 (完全一致・ドメイン・フリーメール除外・曖昧) と更新の決まりを固定する。
import { describe, expect, it } from "vitest";
import { sponsor } from "../src/index";

const lead = (id: string, companyName: string, contactEmail: string | null = null) => ({ id, companyName, contactEmail });
const card = (companyName: string | null, email: string | null) => ({ companyName, email });

describe("parseContactEmails", () => {
  it("reads several addresses written with ／, commas and (CC) notes", () => {
    expect(sponsor.parseContactEmails("Yamada@A.example.co.jp／sato@a.example.co.jp（CC）")).toEqual([
      "yamada@a.example.co.jp",
      "sato@a.example.co.jp",
    ]);
    expect(sponsor.parseContactEmails("a@x.jp, b@y.jp; a@x.jp")).toEqual(["a@x.jp", "b@y.jp"]);
    expect(sponsor.parseContactEmails("ｙａｍａｄａ＠ｂ.ｊｐ")).toEqual(["yamada@b.jp"]);
    expect(sponsor.parseContactEmails(null)).toEqual([]);
    expect(sponsor.parseContactEmails("担当者に確認中")).toEqual([]);
  });

  it("normalizes one address or rejects anything else", () => {
    expect(sponsor.normalizeAddress(" <Yamada@A.jp> ")).toBe("yamada@a.jp");
    expect(sponsor.normalizeAddress("a@x.jp, b@y.jp")).toBeNull();
    expect(sponsor.normalizeAddress("not an address")).toBeNull();
  });
});

describe("buildLeadMatcher (登録したアドレスだけ)", () => {
  const leads = [
    lead("l_a", "株式会社北陸テック", "yamada@hokuriku.example.jp"),
    lead("l_b", "金沢クラウド合同会社", "info@kanazawa.example.jp／sales@kanazawa.example.jp"),
    lead("l_c", "能登ソフトウェア株式会社"),
  ];
  const cards = [
    // 表記ゆれ「（株）」でも同じ会社 (companyKey) の名刺。
    card("（株）北陸テック", "kawaguchi@hokuriku.example.jp"),
    card("能登ソフトウェア", "ishikawa@noto.example.jp"),
    // 営業先の無い会社の名刺は数えない。
    card("加賀デジタル協会", "komatsu@kaga.example.jp"),
    card(null, "nobody@x.example.jp"),
  ];

  it("matches the lead's contact email (several written in one cell)", () => {
    const match = sponsor.buildLeadMatcher(leads, cards);
    expect(match("YAMADA@hokuriku.example.jp")).toEqual({ leadId: "l_a", by: "contact" });
    expect(match("sales@kanazawa.example.jp")).toEqual({ leadId: "l_b", by: "contact" });
  });

  it("matches an email registered on a business card of the same company", () => {
    const match = sponsor.buildLeadMatcher(leads, cards);
    expect(match("kawaguchi@hokuriku.example.jp")).toEqual({ leadId: "l_a", by: "card" });
    expect(match("ishikawa@noto.example.jp")).toEqual({ leadId: "l_c", by: "card" });
    expect(match("komatsu@kaga.example.jp")).toBeNull();
    expect(match("nobody@x.example.jp")).toBeNull();
  });

  it("never guesses from the domain: another person at the same company does not count", () => {
    const match = sponsor.buildLeadMatcher(leads, cards);
    expect(match("someone@hokuriku.example.jp")).toBeNull();
    expect(match("new@noto.example.jp")).toBeNull();
    expect(match("suzuki@developershub.jp")).toBeNull();
  });

  it("does not update anything when the same address is registered for two leads", () => {
    const match = sponsor.buildLeadMatcher([...leads, lead("l_dup", "別会社", "yamada@hokuriku.example.jp")], cards);
    expect(match("yamada@hokuriku.example.jp")).toBeNull();
    // 会社名の照合キーが同じ営業先が 2 社あると、名刺のアドレスも曖昧。
    const twins = sponsor.buildLeadMatcher([...leads, lead("l_twin", "北陸テック")], cards);
    expect(twins("kawaguchi@hokuriku.example.jp")).toBeNull();
  });

  it("lists a lead's registered addresses (contact first, our own domain left out)", () => {
    expect(sponsor.registeredAddresses(lead("l_a", "株式会社北陸テック", "yamada@hokuriku.example.jp／me@developershub.jp"), cards)).toEqual([
      { address: "yamada@hokuriku.example.jp", by: "contact" },
      { address: "kawaguchi@hokuriku.example.jp", by: "card" },
    ]);
  });
});

describe("applyMailContacts", () => {
  const base = { status: "未接触" as sponsor.LeadStatus, firstContactOn: null as string | null, lastContactOn: null as string | null };

  it("a sent mail starts the contact: 初回連絡 + both dates", () => {
    const { next, changes } = sponsor.applyMailContacts(base, [{ direction: "sent", on: "2026-11-05" }]);
    expect(next).toEqual({ status: "初回連絡", firstContactOn: "2026-11-05", lastContactOn: "2026-11-05" });
    expect(changes.map((c) => c.field)).toEqual(["status", "firstContactOn", "lastContactOn"]);
    // applyLeadMilestones と同じ結果 (初回連絡日を明示しているので今日は入らない)。
    const viaMilestones = sponsor.applyLeadMilestones(
      "未接触",
      { ...base, status: "初回連絡" as const, firstContactOn: "2026-11-05", proposedOn: null, agreedOn: null },
      ["firstContactOn"],
      "2026-11-06",
    );
    expect(viaMilestones.firstContactOn).toBe(next.firstContactOn);
    expect(viaMilestones.proposedOn).toBeNull();
  });

  it("keeps the earliest first contact and the latest last contact", () => {
    const cur = { status: "提案済" as sponsor.LeadStatus, firstContactOn: "2026-10-10", lastContactOn: "2026-10-20" };
    expect(sponsor.applyMailContacts(cur, [{ direction: "sent", on: "2026-10-15" }]).changes).toEqual([]);
    expect(sponsor.applyMailContacts(cur, [{ direction: "sent", on: "2026-10-01" }]).next).toEqual({ ...cur, firstContactOn: "2026-10-01" });
    expect(sponsor.applyMailContacts(cur, [{ direction: "received", on: "2026-11-01" }]).next).toEqual({ ...cur, lastContactOn: "2026-11-01" });
  });

  it("fills an empty first-contact date on a lead that is already further along, without moving its status", () => {
    const cur = { status: "社内検討" as sponsor.LeadStatus, firstContactOn: null, lastContactOn: null };
    expect(sponsor.applyMailContacts(cur, [{ direction: "sent", on: "2026-09-01" }]).next).toEqual({
      status: "社内検討",
      firstContactOn: "2026-09-01",
      lastContactOn: "2026-09-01",
    });
  });

  it("a reply moves 初回連絡 → 返信あり only (never sets the first-contact date)", () => {
    expect(sponsor.applyMailContacts({ ...base, status: "初回連絡" }, [{ direction: "received", on: "2026-11-02" }]).next).toEqual({
      status: "返信あり",
      firstContactOn: null,
      lastContactOn: "2026-11-02",
    });
    // 未接触への受信 (先方から来た) はステータスを動かさない。
    expect(sponsor.applyMailContacts(base, [{ direction: "received", on: "2026-11-02" }]).next.status).toBe("未接触");
  });

  it("applies mails oldest first, sent before received on the same day", () => {
    const { next } = sponsor.applyMailContacts(base, [
      { direction: "received", on: "2026-11-03" },
      { direction: "sent", on: "2026-11-03" },
    ]);
    expect(next.status).toBe("返信あり");
    // 返信が先 (先方から) なら、後から送っても 初回連絡 止まり。
    const reverse = sponsor.applyMailContacts(base, [
      { direction: "received", on: "2026-11-01" },
      { direction: "sent", on: "2026-11-03" },
    ]);
    expect(reverse.next.status).toBe("初回連絡");
  });

  it("never touches the status of 見送り or moves a status backwards", () => {
    const dropped = { status: "見送り" as sponsor.LeadStatus, firstContactOn: null, lastContactOn: null };
    const r = sponsor.applyMailContacts(dropped, [
      { direction: "sent", on: "2026-10-01" },
      { direction: "received", on: "2026-10-02" },
    ]);
    expect(r.next.status).toBe("見送り");
    expect(r.next.firstContactOn).toBe("2026-10-01");
    for (const s of ["返信あり", "提案済", "内諾", "契約済"] as const) {
      expect(sponsor.applyMailContacts({ ...base, status: s }, [{ direction: "sent", on: "2026-10-01" }, { direction: "received", on: "2026-10-02" }]).next.status).toBe(s);
    }
  });

  it("is idempotent (re-running a backfill changes nothing)", () => {
    const mails = [
      { direction: "sent" as const, on: "2026-10-01" },
      { direction: "received" as const, on: "2026-10-04" },
    ];
    const once = sponsor.applyMailContacts(base, mails).next;
    expect(sponsor.applyMailContacts(once, mails).changes).toEqual([]);
  });
});
