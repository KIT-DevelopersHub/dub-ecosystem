// Send/receive pattern matrix (test/patterns/matrix.ts) driven through the real email()
// handler and POST /mail/outbox against an in-memory D1. Invariants per pattern: every
// roster recipient (To/CC/BCC) sees the mail once, nothing is lost, BCC never leaks,
// replies join the root thread, attachments are stored (or visibly stubbed).
import { describe, it, expect } from "vitest";
import { MATRIX } from "./patterns/matrix";
import { runPattern } from "./patterns/loopback";

// MAIL_MATRIX_STRICT=1 runs known-issue rows as normal tests to print their real failures.
const STRICT = process.env.MAIL_MATRIX_STRICT === "1";

describe("mail send-pattern matrix", () => {
  it("has unique pattern ids", () => {
    const ids = MATRIX.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const p of MATRIX) {
    if (p.knownIssue && !STRICT) {
      // Known defect (see p.knownIssue.ref). it.fails: green while broken, red once fixed.
      it.fails(`${p.id} — ${p.title} [known: ${p.knownIssue.ref}]`, () => runPattern(p), 30_000);
    } else {
      it(`${p.id} — ${p.title}`, () => runPattern(p), 30_000);
    }
  }
});
