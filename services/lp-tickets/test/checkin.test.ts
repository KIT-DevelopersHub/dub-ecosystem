// 当日受付（/lp/tickets/checkin*）: 1 日 1 回・通し券は両日・Day 券は自分の日だけ・返金済みは不可・取り消し・一覧。
// memory と本物の D1 SQL（node:sqlite に 0001〜0003）の両方で同じ振る舞いを確かめる。
import { describe, it, expect } from "vitest";
import { fulfilmentOf } from "../src/delivery";
import { dayCheck, labelDates, parseCode } from "../src/checkin";
import { ticketToken } from "../src/ticket-token";
import type { LpTicketCheckinResponse, LpTicketCheckinsPage, LpTicketCheckinUndoResponse, TicketOrderRow } from "../src/types";
import { get, makeApp, send, type RepoKind } from "./harness";

const SECRET = "harness-secret";
const DAY1 = "2026-12-12";
const DAY2 = "2026-12-13";
const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function setup(kind: RepoKind, grants: ("lp:checkin" | "lp:publish")[] = ["lp:checkin"]) {
  const h = await makeApp(kind, "view", grants);
  // 券種は edit で作る（受付係は view + lp:checkin だけ）。
  const admin = await makeApp(kind, "edit", ["lp:publish"], { repo: h.repo });
  const mkType = async (name: string, dayLabel: string) =>
    (await body<{ id: string }>(
      await admin.app.fetch(send("POST", "/lp/tickets/types", { name, description: "", priceJpy: 3000, capacity: null, active: true, dayLabel })),
    )).id;
  const types = {
    pass: await mkType("通し", ""),
    day1: await mkType("Day 1 券", "Day 1 · 12/12(土)"),
    day2: await mkType("Day 2 券", "Day 2 · 12/13(日)"),
    vague: await mkType("Day 1（日付なし）", "Day 1"),
  };
  let n = 0;
  /** 支払い済みの 1 注文（qty 枚）を作って券を発行し、券 ID を返す。 */
  const paidTickets = async (typeId: string, qty = 1): Promise<{ order: TicketOrderRow; ids: string[] }> => {
    const now = "2026-12-01T00:00:00.000Z";
    const id = `tko_0000000000000ORDER${String(n++).padStart(3, "0")}`;
    const type = (await h.repo.getTicketType("hokuriku-it-conf.com", typeId))!;
    const row: TicketOrderRow = {
      id,
      site: type.site,
      items: [{ ticketTypeId: typeId, ticketTypeName: type.name, dayLabel: type.dayLabel, unitPriceJpy: 3000, quantity: qty }],
      quantity: qty,
      amountJpy: 3000 * qty,
      status: "pending",
      buyerName: "山田 太郎",
      buyerEmail: "taro@example.com",
      answers: [],
      createdAt: now,
      paidAt: null,
      reviewReason: null,
      couponId: null,
      paymentMethod: null,
      preview: false,
      stripeSessionId: null,
      paymentIntentId: null,
      refundedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      clientKey: null,
      receiptName: null,
    };
    expect(await h.repo.insertOrderIfAvailable(row, new Map([[typeId, null]]), now)).toEqual({ ok: true });
    expect(await h.repo.markOrderPaid(id, { paidAt: now, sessionId: null, paymentIntentId: null })).toBe("paid");
    const order = (await h.repo.getOrder(type.site, id))!;
    const f = fulfilmentOf(order, now);
    await h.repo.issueFulfilment(id, f.tickets, []);
    return { order, ids: f.tickets.map((t) => t.id) };
  };
  const checkin = async (code: string, eventDay?: string) =>
    body<LpTicketCheckinResponse>(await h.app.fetch(send("POST", "/lp/tickets/checkin", { code, ...(eventDay ? { eventDay } : {}) })));
  return { ...h, types, paidTickets, checkin };
}

describe("parsing helpers", () => {
  it("reads dates out of a free-text dayLabel", () => {
    expect([...labelDates("Day 1 · 9/13(月)")]).toEqual(["9-13"]);
    expect([...labelDates("12月12日")]).toEqual(["12-12"]);
    expect([...labelDates("２０２６-１２-１３")]).toEqual(["12-13"]);
    expect([...labelDates("Day 1")]).toEqual([]);
  });
  it("matches a label against the event day", () => {
    expect(dayCheck("", DAY1)).toBe("all_days");
    expect(dayCheck("Day 1 · 12/12(土)", DAY1)).toBe("match");
    expect(dayCheck("Day 1 · 12/12(土)", DAY2)).toBe(false);
    expect(dayCheck("Day 1", DAY2)).toBe("unverified");
  });
  it("takes the token from a ticket URL, else a ticket id / order ref", () => {
    expect(parseCode("https://hokuriku-it-conf.com/t/tko_1-1.abcdefghijklmnopqrstuvwx?x=1")).toEqual({ token: "tko_1-1.abcdefghijklmnopqrstuvwx" });
    expect(parseCode(" tko_ABC-1 ")).toEqual({ ticketId: "tko_ABC-1" });
    expect(parseCode("abcd1234-2")).toEqual({ orderRef: "ABCD1234", seat: 2 });
    expect(parseCode("")).toBeNull();
    expect(parseCode("<script>")).toBeNull();
  });
});

for (const kind of ["memory", "d1"] as const) {
  describe(`checkin (${kind})`, () => {
    it("checks in once per day; the second scan says already (with the first time)", async () => {
      const h = await setup(kind);
      const { ids } = await h.paidTickets(h.types.pass);
      const token = await ticketToken(SECRET, ids[0]!);
      h.clock.set("2026-12-12T00:30:00.000Z");
      const first = await h.checkin(`https://hokuriku-it-conf.com/t/${token}`, DAY1);
      expect(first).toMatchObject({ result: "ok", eventDay: DAY1, dayCheck: "all_days", checkedInBy: "usr_admin" });
      expect(first.ticket).toMatchObject({ ticketId: ids[0], ticketTypeName: "通し", buyerName: "山田 太郎", holderName: null });
      h.clock.set("2026-12-12T01:00:00.000Z");
      const again = await h.checkin(token, DAY1);
      expect(again).toMatchObject({ result: "already", checkedInAt: "2026-12-12T00:30:00.000Z" });
    });

    it("two scanners at once: exactly one ok", async () => {
      const h = await setup(kind);
      const { ids } = await h.paidTickets(h.types.pass);
      const rs = await Promise.all([h.checkin(ids[0]!, DAY1), h.checkin(ids[0]!, DAY1)]);
      expect(rs.map((r) => r.result).sort()).toEqual(["already", "ok"]);
    });

    it("a 通し券 checks in again on day 2", async () => {
      const h = await setup(kind);
      const { ids } = await h.paidTickets(h.types.pass);
      expect((await h.checkin(ids[0]!, DAY1)).result).toBe("ok");
      expect((await h.checkin(ids[0]!, DAY2)).result).toBe("ok");
    });

    it("a day ticket is only valid on its own day", async () => {
      const h = await setup(kind);
      const { ids } = await h.paidTickets(h.types.day1);
      expect(await h.checkin(ids[0]!, DAY2)).toMatchObject({ result: "wrong_day", checkedInAt: null });
      expect(await h.checkin(ids[0]!, DAY1)).toMatchObject({ result: "ok", dayCheck: "match" });
    });

    it("an undated day label is let through but flagged unverified", async () => {
      const h = await setup(kind);
      const { ids } = await h.paidTickets(h.types.vague);
      expect(await h.checkin(ids[0]!, DAY2)).toMatchObject({ result: "ok", dayCheck: "unverified" });
    });

    it("defaults the event day to today in JST", async () => {
      const h = await setup(kind);
      const { ids } = await h.paidTickets(h.types.pass);
      h.clock.set("2026-12-12T15:30:00.000Z"); // 00:30 JST on the 13th
      expect(await h.checkin(ids[0]!)).toMatchObject({ result: "ok", eventDay: DAY2 });
    });

    it("refunded tickets are void", async () => {
      const h = await setup(kind);
      const { order, ids } = await h.paidTickets(h.types.pass);
      expect(await h.repo.markOrderRefunded(order.id, "2026-12-05T00:00:00.000Z")).toBe(true);
      expect(await h.checkin(ids[0]!, DAY1)).toMatchObject({ result: "void", checkedInAt: null });
      const list = await body<LpTicketCheckinsPage>(await h.app.fetch(get(`/lp/tickets/checkins?day=${DAY1}`)));
      expect(list.count).toBe(0);
    });

    it("unknown codes and forged tokens are unknown, never a 500", async () => {
      const h = await setup(kind);
      const { ids } = await h.paidTickets(h.types.pass);
      expect((await h.checkin("tko_nope-1", DAY1)).result).toBe("unknown");
      expect((await h.checkin(`${ids[0]}.AAAAAAAAAAAAAAAAAAAAAAAA`, DAY1)).result).toBe("unknown");
      expect((await h.checkin("!!", DAY1)).result).toBe("unknown");
    });

    it("manual entry by order number: seat required for multi-ticket orders", async () => {
      const h = await setup(kind);
      const one = await h.paidTickets(h.types.pass, 1);
      const two = await h.paidTickets(h.types.pass, 2);
      const ref1 = one.order.id.slice(-8).toLowerCase();
      const ref2 = two.order.id.slice(-8);
      expect(await h.checkin(ref1, DAY1)).toMatchObject({ result: "ok", ticket: { ticketId: one.ids[0] } });
      expect((await h.checkin(ref2, DAY1)).result).toBe("unknown");
      expect(await h.checkin(`${ref2}-2`, DAY1)).toMatchObject({ result: "ok", ticket: { ticketId: two.ids[1], orderRef: ref2.toUpperCase() } });
    });

    it("undo removes that day's check-in only, and a second undo is a no-op", async () => {
      const h = await setup(kind);
      const { ids } = await h.paidTickets(h.types.pass);
      await h.checkin(ids[0]!, DAY1);
      await h.checkin(ids[0]!, DAY2);
      const undo = await body<LpTicketCheckinUndoResponse>(await h.app.fetch(send("DELETE", `/lp/tickets/checkin/${ids[0]}?day=${DAY1}`, {})));
      expect(undo).toEqual({ ticketId: ids[0], eventDay: DAY1, removed: true });
      const again = await body<LpTicketCheckinUndoResponse>(await h.app.fetch(send("DELETE", `/lp/tickets/checkin/${ids[0]}?day=${DAY1}`, {})));
      expect(again.removed).toBe(false);
      expect((await h.checkin(ids[0]!, DAY1)).result).toBe("ok");
      expect((await h.checkin(ids[0]!, DAY2)).result).toBe("already");
    });

    it("lists a day newest first with per-day counts and a cursor", async () => {
      const h = await setup(kind);
      const { ids } = await h.paidTickets(h.types.pass, 3);
      for (const [i, id] of ids.entries()) {
        h.clock.set(`2026-12-12T00:0${i}:00.000Z`);
        await h.checkin(id, DAY1);
      }
      await h.checkin(ids[0]!, DAY2);
      const p1 = await body<LpTicketCheckinsPage>(await h.app.fetch(get(`/lp/tickets/checkins?day=${DAY1}&limit=2`)));
      expect(p1.count).toBe(3);
      expect(p1.days).toEqual([
        { eventDay: DAY1, count: 3 },
        { eventDay: DAY2, count: 1 },
      ]);
      expect(p1.items.map((i) => i.ticketId)).toEqual([ids[2], ids[1]]);
      expect(p1.items[0]).toMatchObject({ buyerName: "山田 太郎", ticketTypeName: "通し", eventDay: DAY1 });
      const p2 = await body<LpTicketCheckinsPage>(
        await h.app.fetch(get(`/lp/tickets/checkins?day=${DAY1}&limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`)),
      );
      expect(p2.items.map((i) => i.ticketId)).toEqual([ids[0]]);
      expect(p2.nextCursor).toBeNull();
    });

    it("rejects a malformed event day", async () => {
      const h = await setup(kind);
      expect((await h.app.fetch(send("POST", "/lp/tickets/checkin", { code: "x", eventDay: "2026-13-01" }))).status).toBe(400);
      expect((await h.app.fetch(get("/lp/tickets/checkins?day=tomorrow"))).status).toBe(400);
    });

    it("403 without lp:checkin, even for a publisher", async () => {
      const h = await setup(kind, ["lp:publish"]);
      expect((await h.app.fetch(send("POST", "/lp/tickets/checkin", { code: "x" }))).status).toBe(403);
      expect((await h.app.fetch(get("/lp/tickets/checkins"))).status).toBe(403);
    });
  });
}
