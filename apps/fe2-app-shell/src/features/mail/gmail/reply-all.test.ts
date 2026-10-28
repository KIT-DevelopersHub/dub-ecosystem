// Reply-all recipient decision table (Gmail / RFC 5322 §3.6.3).
import { describe, expect, it } from "vitest";
import { dedupPeople, replyAllRecipients, type MailMsg, type MailPerson } from "./mailModel.ts";

const own = new Set(["me@developershub.jp", "role@developershub.jp"]);
const msg = (p: Partial<MailMsg>): MailMsg => ({
  id: "m1",
  from: { email: "alice@example.com", name: "Alice" },
  to: [],
  date: "2026-10-27T00:00:00.000Z",
  body: "",
  read: true,
  ...p,
});
const emails = (ps: MailPerson[]): string[] => ps.map((p) => p.email);

describe("replyAllRecipients", () => {
  it("sender + original To go to To; original Cc stays in Cc", () => {
    const r = replyAllRecipients(
      msg({ to: [{ email: "me@developershub.jp" }, { email: "bob@example.com" }], cc: [{ email: "carol@example.com" }] }),
      own,
    );
    expect(emails(r.to)).toEqual(["alice@example.com", "bob@example.com"]);
    expect(emails(r.cc)).toEqual(["carol@example.com"]);
  });

  it("Reply-To replaces the sender as the reply target", () => {
    const r = replyAllRecipients(
      msg({ to: [{ email: "me@developershub.jp" }], headerMeta: { replyTo: [{ email: "list@example.com" }] } as MailMsg["headerMeta"] }),
      own,
    );
    expect(emails(r.to)).toEqual(["list@example.com"]);
    expect(r.cc).toEqual([]);
  });

  it("drops me (any own address, any case) when I am in Cc", () => {
    const r = replyAllRecipients(
      msg({ to: [{ email: "bob@example.com" }], cc: [{ email: "ME@DevelopersHub.jp" }, { email: "Role@developershub.jp" }, { email: "dave@example.com" }] }),
      own,
    );
    expect(emails(r.to)).toEqual(["alice@example.com", "bob@example.com"]);
    expect(emails(r.cc)).toEqual(["dave@example.com"]);
  });

  it("dedupes case-insensitively across To and Cc (To wins)", () => {
    const r = replyAllRecipients(
      msg({
        to: [{ email: "Alice@Example.com" }, { email: "bob@example.com" }, { email: "BOB@example.com" }],
        cc: [{ email: "bob@EXAMPLE.com" }, { email: "carol@example.com" }, { email: "Carol@example.com" }],
      }),
      own,
    );
    expect(emails(r.to)).toEqual(["alice@example.com", "bob@example.com"]);
    expect(emails(r.cc)).toEqual(["carol@example.com"]);
  });

  it("external-only thread (I am not listed) keeps everyone", () => {
    const r = replyAllRecipients(msg({ to: [{ email: "bob@example.com" }], cc: [{ email: "carol@example.com" }] }), own);
    expect(emails(r.to)).toEqual(["alice@example.com", "bob@example.com"]);
    expect(emails(r.cc)).toEqual(["carol@example.com"]);
  });
});

describe("dedupPeople", () => {
  it("compares lowercased and drops empty / skipped addresses", () => {
    expect(emails(dedupPeople([{ email: "A@x.com" }, { email: "a@X.com" }, { email: "" }, { email: "me@developershub.jp" }], own))).toEqual(["A@x.com"]);
  });
});
