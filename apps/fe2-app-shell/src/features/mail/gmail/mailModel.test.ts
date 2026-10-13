// Unit tests for the derived reply nudge (返信していないメール).
import { describe, expect, it } from "vitest";
import { replyNudge, SELF, type MailMsg, type MailThreadModel } from "./mailModel.ts";
import { initialMailState, reducer } from "./useMailStore.tsx";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const daysAgo = (d: number, extraMs = 0): string => new Date(NOW.getTime() - d * 86_400_000 - extraMs).toISOString();

function msg(over: Partial<MailMsg> = {}): MailMsg {
  return { id: "m", from: { email: "hanako@example.com" }, to: [{ email: "me@developershub.jp" }], date: daysAgo(3), body: "", read: true, ...over };
}
function thread(messages: MailMsg[], over: Partial<MailThreadModel> = {}): MailThreadModel {
  return { id: "T", subject: "相談", messages, folder: "inbox", starred: false, labels: [], ...over };
}

describe("replyNudge", () => {
  it("fires at the 3 whole-day boundary, not before", () => {
    expect(replyNudge(thread([msg({ date: daysAgo(2, 86_399_000) })]), NOW)).toBeNull();
    expect(replyNudge(thread([msg({ date: daysAgo(3) })]), NOW)).toEqual({ days: 3 });
    expect(replyNudge(thread([msg({ date: daysAgo(5, 3_600_000) })]), NOW)).toEqual({ days: 5 });
  });

  it("clears once we replied after the latest received message", () => {
    const replied = thread([msg({ id: "in" }), msg({ id: "out", outbound: true, date: daysAgo(1) })]);
    expect(replyNudge(replied, NOW)).toBeNull();
  });

  it("clears on the optimistic inline reply (ADD_MESSAGE) without extra state", () => {
    const state = { ...initialMailState, me: SELF, threads: [thread([msg({ date: new Date(Date.now() - 4 * 86_400_000).toISOString() })])] };
    expect(replyNudge(state.threads[0]!, new Date())).toEqual({ days: 4 });
    const next = reducer(state, { type: "ADD_MESSAGE", threadId: "T", body: "了解です", to: [{ email: "hanako@example.com" }], subject: "相談" });
    expect(replyNudge(next.threads[0]!, new Date())).toBeNull();
  });

  it("reappears when the correspondent writes again after our reply", () => {
    const t = thread([msg({ id: "in1", date: daysAgo(9) }), msg({ id: "out", outbound: true, date: daysAgo(8) }), msg({ id: "in2", date: daysAgo(4) })]);
    expect(replyNudge(t, NOW)).toEqual({ days: 4 });
  });

  it("skips mail seen only via role sharing / oversight", () => {
    expect(replyNudge(thread([msg({ mine: false })]), NOW)).toBeNull();
  });

  it("only applies to the inbox", () => {
    for (const folder of ["archive", "trash", "sent"] as const) expect(replyNudge(thread([msg()], { folder }), NOW)).toBeNull();
    expect(replyNudge(thread([msg()], { purged: true }), NOW)).toBeNull();
  });

  it("ignores automated senders", () => {
    for (const email of ["noreply@x.jp", "no-reply@x.jp", "do-not-reply@x.jp", "MAILER-DAEMON@x.jp", "notifications@github.com", "bounce+abc@x.jp"]) {
      expect(replyNudge(thread([msg({ from: { email } })]), NOW)).toBeNull();
    }
  });

  it("accepts a custom threshold", () => {
    expect(replyNudge(thread([msg({ date: daysAgo(1) })]), NOW, 1)).toEqual({ days: 1 });
  });
});
