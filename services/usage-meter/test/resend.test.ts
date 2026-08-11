import { describe, it, expect } from "vitest";
import { createDbClient } from "@dub/db";
import { makeD1, seedSend } from "./d1";
import { countResendSends } from "../src/resend-usage";

const NOW = new Date("2026-08-12T09:30:00.000Z");

describe("countResendSends", () => {
  it("counts sent rows for today and this month (UTC), excluding failed/pending", () => {
    const { d1, raw } = makeD1();
    // today
    seedSend(raw, "s1", "2026-08-12T01:00:00.000Z");
    seedSend(raw, "s2", "2026-08-12T08:00:00.000Z");
    // earlier this month (counts for month, not day)
    seedSend(raw, "s3", "2026-08-03T10:00:00.000Z");
    // last month (counts for neither)
    seedSend(raw, "s4", "2026-07-30T10:00:00.000Z");
    // failed today (excluded)
    seedSend(raw, "s5", "2026-08-12T02:00:00.000Z", "failed");

    const db = createDbClient(d1, { namespace: "mail" });
    return countResendSends(db, NOW).then((c) => {
      expect(c.day).toBe(2);
      expect(c.month).toBe(3);
    });
  });

  it("returns 0/0 on an empty log (not null)", async () => {
    const { d1 } = makeD1();
    const db = createDbClient(d1, { namespace: "mail" });
    const c = await countResendSends(db, NOW);
    expect(c).toEqual({ day: 0, month: 0 });
  });
});
