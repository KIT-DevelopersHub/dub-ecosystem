// Sent-folder tests: body/recipient persistence on the send-log (migration 0004) and
// the listSent / getSentDetail projections. Runs against the in-memory D1 (real schema)
// via the shared harness — a send goes through the full send core, then the Sent read
// APIs must surface it. Only status='sent' rows are listed (pending/failed excluded).
import { describe, it, expect } from "vitest";
import type { mail } from "@dub/types";
import { sendMail } from "../src/send";
import { getSentDetail, listSent, snippetOf, findSendByKey } from "../src/repo";
import { makeHarness, sendDeps } from "./helpers";

const req = (over: Partial<mail.SendMailRequest> = {}): mail.SendMailRequest => ({
  to: [{ email: "alice@example.com", name: "Alice" }],
  subject: "Hello",
  textBody: "Line one.\nLine two.",
  ...over,
});

describe("snippetOf", () => {
  it("collapses whitespace to a single line and truncates to the max", () => {
    expect(snippetOf("a\n\n  b   c")).toBe("a b c");
    expect(snippetOf("x".repeat(200)).length).toBe(140);
  });
});

describe("send-log body persistence (0004)", () => {
  it("persists textBody / cc / from / snippet on the claim, then marks the row sent", async () => {
    const h = makeHarness();
    const deps = sendDeps(h); // fromAddress = info@developershub.jp
    await sendMail(deps, req({ cc: [{ email: "cc@example.com" }], htmlBody: "<p>hi</p>" }), "s-1", "usr_alice");

    const row = await findSendByKey(h.db, "s-1");
    expect(row?.status).toBe("sent");
    expect(row?.text_body).toBe("Line one.\nLine two.");
    expect(row?.html_body).toBe("<p>hi</p>");
    expect(row?.from_address).toBe("info@developershub.jp");
    expect(JSON.parse(row!.cc_json!)).toEqual([{ email: "cc@example.com" }]);
    expect(row?.snippet).toBe("Line one. Line two.");
  });
});

describe("listSent / getSentDetail", () => {
  it("lists only delivered mail, newest first, with recipients + snippet", async () => {
    const h = makeHarness();
    const deps = sendDeps(h);
    await sendMail(deps, req({ subject: "First" }), "a", "usr_alice");
    await sendMail(deps, req({ subject: "Second", cc: [{ email: "c@x.com" }] }), "b", "usr_alice");

    const page = await listSent(h.db, { limit: 50 });
    expect(page.items).toHaveLength(2);
    // newest first
    expect(page.items[0]!.subject).toBe("Second");
    expect(page.items[0]!.cc).toEqual([{ email: "c@x.com" }]);
    expect(page.items[0]!.to).toEqual([{ email: "alice@example.com", name: "Alice" }]);
    expect(page.items[0]!.status).toBe("sent");
    expect(page.items[0]!.snippet).toBe("Line one. Line two.");
    expect(page.items[0]!.provider).toBe("resend");
    expect(page.items[0]!.providerMessageId).toContain("mock-");
    expect(page.nextCursor).toBeNull();
  });

  it("paginates with an opaque cursor", async () => {
    const h = makeHarness();
    const deps = sendDeps(h);
    for (let i = 0; i < 3; i++) await sendMail(deps, req({ subject: `M${i}` }), `k${i}`, "usr_alice");

    const first = await listSent(h.db, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listSent(h.db, { limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    // no overlap
    const ids = new Set([...first.items, ...second.items].map((x) => x.id));
    expect(ids.size).toBe(3);
  });

  it("getSentDetail returns the full body for a delivered row, null otherwise", async () => {
    const h = makeHarness();
    const deps = sendDeps(h);
    await sendMail(deps, req({ htmlBody: "<b>x</b>" }), "d1", "usr_alice");
    const row = await findSendByKey(h.db, "d1");

    const detail = await getSentDetail(h.db, row!.id);
    expect(detail?.textBody).toBe("Line one.\nLine two.");
    expect(detail?.htmlBody).toBe("<b>x</b>");

    expect(await getSentDetail(h.db, "does-not-exist")).toBeNull();
  });

  it("does NOT list a failed send (only status='sent')", async () => {
    const h = makeHarness({ fail: true });
    const deps = sendDeps(h);
    await expect(sendMail(deps, req(), "f1", "usr_alice")).rejects.toBeTruthy();
    const page = await listSent(h.db, { limit: 50 });
    expect(page.items).toHaveLength(0);
  });
});
