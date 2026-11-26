// LP管理 → 受付 のテスト。
//   (1) view-model（lpCheckin.ts）: 結果の表示・カメラの重複読み取り・楽観更新の計算
//   (2) demo transport が受付のワイヤ契約に応答すること（REAL api-client 経由）
//   (3) LpCheckinScreen: lp:checkin が無いと説明だけ / 手入力で受付 → 人数と一覧 / 2 回目は受付済み /
//       失敗で人数を戻す / 一覧から取り消し
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { identity } from "@dub/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { todayJst } from "./lpTickets.ts";
import { createLpApi, type LpApi, type LpTicketCheckinResponse, type LpTicketCheckinsPage } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { LpCheckinScreen } from "./LpCheckinScreen.tsx";
import {
  attendeeName,
  checkinView,
  formatEventDay,
  normalizeManualCode,
  shouldAcceptScan,
  withCheckinRow,
  withoutCheckin,
  withPendingCheckin,
} from "./lpCheckin.ts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const RECEPTION = viewerPermissions("lp", ["lp:checkin"]);
const DAY = "2026-12-12";

const ticket = { ticketId: "tko_1-1", orderRef: "ABCD1234", ticketTypeName: "一般", dayLabel: "", holderName: null, buyerName: "山田 太郎" };
const res = (over: Partial<LpTicketCheckinResponse> = {}): LpTicketCheckinResponse => ({
  result: "ok",
  eventDay: DAY,
  ticket,
  checkedInAt: "2026-12-12T00:30:00.000Z",
  checkedInBy: "usr_a",
  dayCheck: "all_days",
  ...over,
});
const page = (over: Partial<LpTicketCheckinsPage> = {}): LpTicketCheckinsPage => ({
  eventDay: DAY,
  count: 0,
  days: [],
  items: [],
  nextCursor: null,
  ...over,
});

afterEach(cleanup);

describe("lpCheckin view-model", () => {
  it("maps every result to a tone and a big title", () => {
    expect(checkinView(res())).toMatchObject({ tone: "ok", title: "受付しました", name: "山田 太郎", canUndo: true, detail: null });
    expect(checkinView(res({ dayCheck: "unverified", ticket: { ...ticket, dayLabel: "Day 1" } }))).toMatchObject({
      tone: "warn",
      detail: "券の日付を確認してください（Day 1）",
    });
    expect(checkinView(res({ result: "already" }))).toMatchObject({ tone: "warn", title: "受付済みです", detail: "09:30 に受付済み", canUndo: false });
    expect(checkinView(res({ result: "void", checkedInAt: null }))).toMatchObject({ tone: "error", title: "無効なチケットです" });
    expect(checkinView(res({ result: "wrong_day", ticket: { ...ticket, dayLabel: "Day 2 · 12/13(日)" } }))).toMatchObject({
      tone: "error",
      detail: "受付日は 12/12(土) です",
    });
    expect(checkinView(res({ result: "unknown", ticket: null }))).toMatchObject({ tone: "error", name: null, ticketLabel: null });
  });

  it("prefers the holder name over the buyer name", () => {
    expect(attendeeName({ holderName: "  鈴木 花子 ", buyerName: "山田 太郎" })).toBe("鈴木 花子");
    expect(attendeeName({ holderName: null, buyerName: "" })).toBe("（名前なし）");
  });

  it("formats the event day with the weekday", () => {
    expect(formatEventDay("2026-12-12")).toBe("12/12(土)");
  });

  it("drops the same camera read within the window", () => {
    expect(shouldAcceptScan("A", null, 0)).toBe(true);
    expect(shouldAcceptScan("A", { code: "A", at: 0 }, 1000)).toBe(false);
    expect(shouldAcceptScan("A", { code: "A", at: 0 }, 5000)).toBe(true);
    expect(shouldAcceptScan("B", { code: "A", at: 0 }, 10)).toBe(true);
    expect(shouldAcceptScan("  ", null, 0)).toBe(false);
  });

  it("normalizes manual input", () => {
    expect(normalizeManualCode(" ＡＢＣＤ１２３４-１ ")).toBe("ABCD1234-1");
    expect(normalizeManualCode("   ")).toBeNull();
  });

  it("optimistic count, then the confirmed row, then undo", () => {
    const p1 = withPendingCheckin(page());
    expect(p1).toMatchObject({ count: 1, days: [{ eventDay: DAY, count: 1 }] });
    const p2 = withCheckinRow(p1, res());
    expect(p2.items.map((i) => i.ticketId)).toEqual(["tko_1-1"]);
    expect(withCheckinRow(p1, res({ result: "already" }))).toBe(p1);
    const p3 = withoutCheckin(p2, "tko_1-1");
    expect(p3).toMatchObject({ count: 0, days: [], items: [] });
    expect(withoutCheckin(p3, "nope")).toBe(p3);
  });
});

function demoLpApi(): LpApi {
  return createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
}

describe("demo transport: 受付", () => {
  it("answers ok, then already, void for a refund, unknown for junk, and lists/undoes", async () => {
    const api = demoLpApi();
    // ord_005 = 招待券（日付なし）x3・支払い済み / ord_009 = 返金済み。
    const first = await api.checkinTicket({ code: "ord_005-1", eventDay: DAY });
    expect(first).toMatchObject({ result: "ok", dayCheck: "all_days", ticket: { buyerName: "高橋 美咲" } });
    expect((await api.checkinTicket({ code: "https://x/t/ord_005-1.sig", eventDay: DAY })).result).toBe("already");
    expect((await api.checkinTicket({ code: "ord_009-1", eventDay: DAY })).result).toBe("void");
    expect((await api.checkinTicket({ code: "zzz", eventDay: DAY })).result).toBe("unknown");
    const list = await api.listTicketCheckins({ day: DAY });
    expect(list).toMatchObject({ count: 1, days: [{ eventDay: DAY, count: 1 }] });
    expect(await api.undoTicketCheckin("ord_005-1", DAY)).toEqual({ ticketId: "ord_005-1", eventDay: DAY, removed: true });
    expect((await api.listTicketCheckins({ day: DAY })).count).toBe(0);
  });
});

function renderScreen(api: LpApi, permissions: readonly identity.PermissionKey[] = RECEPTION): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={permissions}>
          <LpApiProvider value={api}>
            <LpCheckinScreen />
          </LpApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function stubApi(over: Partial<LpApi>): LpApi {
  return { ...demoLpApi(), ...over };
}

describe("LpCheckinScreen", () => {
  it("explains the missing permission instead of showing the scanner", async () => {
    renderScreen(demoLpApi(), viewerPermissions("lp"));
    expect(await screen.findByTestId("fe2-lp-checkin-forbidden")).toHaveTextContent("lp:checkin");
    expect(screen.queryByTestId("fe2-lp-checkin-scanner")).toBeNull();
  });

  it("shows skeletons while the list loads", async () => {
    renderScreen(stubApi({ listTicketCheckins: () => new Promise(() => undefined) }));
    expect(await screen.findByTestId("fe2-lp-checkin-count-loading")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-checkin-list-loading")).toBeInTheDocument();
  });

  it("checks in by manual entry: big OK, count +1, row in the list; the second time says already", async () => {
    renderScreen(demoLpApi());
    await waitFor(() => expect(screen.getByTestId("fe2-lp-checkin-count")).toHaveTextContent("0"));
    // 招待券は日付なしなので、どの受付日でも通る。
    fireEvent.change(screen.getByTestId("fe2-lp-checkin-code"), { target: { value: "ord_005-2" } });
    fireEvent.click(screen.getByTestId("fe2-lp-checkin-submit"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-checkin-result-title")).toHaveTextContent("受付しました"));
    expect(screen.getByTestId("fe2-lp-checkin-result")).toHaveAttribute("data-tone", "ok");
    expect(screen.getByTestId("fe2-lp-checkin-result")).toHaveTextContent("高橋 美咲 さん");
    expect(screen.getByTestId("fe2-lp-checkin-count")).toHaveTextContent("1");
    expect(within(screen.getByTestId("fe2-lp-checkin-list")).getByText("高橋 美咲")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("fe2-lp-checkin-code"), { target: { value: "ord_005-2" } });
    fireEvent.click(screen.getByTestId("fe2-lp-checkin-submit"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-checkin-result-title")).toHaveTextContent("受付済みです"));
    expect(screen.getByTestId("fe2-lp-checkin-result")).toHaveAttribute("data-tone", "warn");
    expect(screen.getByTestId("fe2-lp-checkin-count")).toHaveTextContent("1");
  });

  it("rolls the optimistic count back when the ticket is not accepted", async () => {
    let resolve: (r: LpTicketCheckinResponse) => void = () => undefined;
    renderScreen(
      stubApi({
        listTicketCheckins: () => Promise.resolve(page({ eventDay: "x", count: 3 })),
        checkinTicket: () => new Promise((r) => (resolve = r)),
      }),
    );
    await waitFor(() => expect(screen.getByTestId("fe2-lp-checkin-count")).toHaveTextContent("3"));
    fireEvent.change(screen.getByTestId("fe2-lp-checkin-code"), { target: { value: "ABCD1234-1" } });
    fireEvent.click(screen.getByTestId("fe2-lp-checkin-submit"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-checkin-count")).toHaveTextContent("4"));
    resolve(res({ result: "void", checkedInAt: null, eventDay: todayJst() }));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-checkin-result")).toHaveAttribute("data-tone", "error"));
    expect(screen.getByTestId("fe2-lp-checkin-count")).toHaveTextContent("3");
  });

  it("undoes from the list optimistically", async () => {
    const undo = vi.fn(() => Promise.resolve({ ticketId: "tko_1-1", eventDay: DAY, removed: true }));
    renderScreen(
      stubApi({
        listTicketCheckins: () =>
          Promise.resolve(
            page({
              count: 1,
              days: [{ eventDay: DAY, count: 1 }],
              items: [{ ...ticket, eventDay: DAY, checkedInAt: "2026-12-12T00:30:00.000Z", checkedInBy: "usr_a" }],
            }),
          ),
        undoTicketCheckin: undo,
      }),
    );
    fireEvent.click(await screen.findByTestId("fe2-lp-checkin-undo-tko_1-1"));
    await waitFor(() => expect(screen.queryByTestId("fe2-lp-checkin-row-tko_1-1")).toBeNull());
    expect(screen.getByTestId("fe2-lp-checkin-count")).toHaveTextContent("0");
    expect(undo).toHaveBeenCalledWith("tko_1-1", expect.any(String));
  });
});
