// LP管理 → チケット のテスト。
//   (1) lpTickets の純粋関数（券種/入力項目の検証が契約と一致すること）
//   (2) demo transport がチケットのワイヤ契約に応答すること（REAL api-client 経由）
//   (3) LpTicketsScreen: 状態から集計を描画 / 公開トグルは lp:publish 必須 / 楽観更新の
//       ロールバック / 券種追加の検証 / 入力項目の一括保存 / 購入者は編集者だけ
//   v2: 対象日（dayLabel）でのグルーピング / 1 回の購入上限 / 参加登録ボタン差し替え（ctaEnabled）/
//       1 注文 = 複数券種 × 枚数
//   v3: 要確認（needs_review）の理由表示と「確認して確定する」（lp:publish 必須・楽観更新 + ロールバック）
//   v4: 無料券のクーポン（一覧/発行/停止は lp:publish 必須・状態バッジ・停止の楽観更新 + ロールバック・
//       購入者のクーポンバッジ・0 円券種の補足）
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import {
  createLpApi,
  type LpApi,
  type LpTicketCoupon,
  type LpTicketOrder,
  type LpTicketsState,
  type LpTicketTypeSummary,
} from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { LpTicketsScreen } from "./LpTicketsScreen.tsx";
import {
  couponExpiryIso,
  couponState,
  groupTicketTypesByDay,
  todayJst,
  validateCouponDraft,
  validateTicketFields,
  validateTicketType,
} from "./lpTickets.ts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const PUBLISHER = editorPermissions("lp", ["lp:publish"]);
const EDITOR = editorPermissions("lp");
const VIEWER = viewerPermissions("lp");

function demoLpApi(): LpApi {
  return createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
}

function ticketType(over: Partial<LpTicketTypeSummary> = {}): LpTicketTypeSummary {
  return {
    id: "tt_general",
    name: "一般",
    description: "",
    priceJpy: 3000,
    capacity: 200,
    dayLabel: "",
    maxPerOrder: 10,
    active: true,
    sortOrder: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    stats: { sold: 4, pending: 1, revenueJpy: 12000, remaining: 195 },
    ...over,
  };
}

function baseState(over: Partial<LpTicketsState> = {}): LpTicketsState {
  return {
    site: "hokuriku-it-conf.com",
    enabled: false,
    ctaEnabled: false,
    paymentReady: false,
    publicUrl: "https://hokuriku-it-conf.com/tickets",
    fields: [{ id: "f_aff", label: "所属", type: "text", required: false, options: [] }],
    types: [ticketType()],
    totals: { sold: 4, revenueJpy: 12000 },
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
}

function fakeApi(overrides: Partial<LpApi> = {}): LpApi {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    getStats: unused,
    getSiteTraffic: unused,
    listVisits: unused,
    listLinks: unused,
    createLink: unused,
    setLinkActive: unused,
    getPublish: unused,
    setPublish: unused,
    getTickets: () => Promise.resolve(baseState()),
    setTicketsEnabled: ({ enabled }) => Promise.resolve(baseState({ enabled })),
    setTicketsCta: ({ enabled }) => Promise.resolve(baseState({ ctaEnabled: enabled })),
    saveTicketFields: ({ fields }) => Promise.resolve(baseState({ fields })),
    createTicketType: unused,
    updateTicketType: unused,
    listTicketOrders: () => Promise.resolve({ items: [], nextCursor: null }),
    approveTicketOrder: unused,
    listTicketCoupons: () => Promise.resolve({ items: [] }),
    createTicketCoupon: unused,
    setTicketCouponActive: unused,
    getProposals: unused,
    setProposalsEnabled: unused,
    saveProposalFields: unused,
    listProposals: unused,
    setProposalStatus: unused,
    ...overrides,
  };
}

function renderScreen(api: LpApi, permissions: readonly identity.PermissionKey[] = PUBLISHER): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={permissions}>
          <LpApiProvider value={api}>
            <LpTicketsScreen />
          </LpApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("lpTickets (pure)", () => {
  const draft = { name: "学生", description: "", price: "1000", capacity: "", dayLabel: "", maxPerOrder: "10", active: true };

  it("accepts free (0) and >= 50 yen, rejects 1..49 (Stripe minimum)", () => {
    expect(validateTicketType({ ...draft, price: "0" }).input?.priceJpy).toBe(0);
    expect(validateTicketType({ ...draft, price: "50" }).input?.priceJpy).toBe(50);
    expect(validateTicketType({ ...draft, price: "30" }).errors.price).toMatch(/50円以上/);
    expect(validateTicketType({ ...draft, price: "abc" }).errors.price).toBeTruthy();
  });

  it("treats an empty capacity as unlimited and rejects 0", () => {
    expect(validateTicketType(draft).input?.capacity).toBeNull();
    expect(validateTicketType({ ...draft, capacity: "0" }).errors.capacity).toBeTruthy();
  });

  it("trims the day label, caps it at 30 chars, and bounds maxPerOrder to 1..20", () => {
    const ok = validateTicketType({ ...draft, dayLabel: "  Day 1 · 9/13(月) ", maxPerOrder: "4" }).input;
    expect(ok).toMatchObject({ dayLabel: "Day 1 · 9/13(月)", maxPerOrder: 4 });
    expect(validateTicketType({ ...draft, dayLabel: "x".repeat(31) }).errors.dayLabel).toMatch(/30文字/);
    expect(validateTicketType({ ...draft, maxPerOrder: "0" }).errors.maxPerOrder).toBeTruthy();
    expect(validateTicketType({ ...draft, maxPerOrder: "21" }).errors.maxPerOrder).toBeTruthy();
    expect(validateTicketType({ ...draft, maxPerOrder: "20" }).input?.maxPerOrder).toBe(20);
  });

  it("groups types by day in first-seen order and sums tickets per day", () => {
    const groups = groupTicketTypesByDay([
      ticketType({ id: "a", dayLabel: "Day 1", stats: { sold: 2, pending: 0, revenueJpy: 6000, remaining: null } }),
      ticketType({ id: "b", dayLabel: "Day 2", stats: { sold: 1, pending: 0, revenueJpy: 3000, remaining: null } }),
      ticketType({ id: "c", dayLabel: "Day 1", stats: { sold: 3, pending: 0, revenueJpy: 3000, remaining: null } }),
      ticketType({ id: "d", dayLabel: "", stats: { sold: 0, pending: 0, revenueJpy: 0, remaining: null } }),
    ]);
    expect(groups.map((g) => g.dayLabel)).toEqual(["Day 1", "Day 2", ""]);
    expect(groups[0]).toMatchObject({ sold: 5, revenueJpy: 9000 });
    expect(groups[0]!.types.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("requires options for a select field and a label for every field", () => {
    expect(validateTicketFields([{ id: "f_a", label: "区分", type: "select", required: true, options: [] }]).f_a).toMatch(/選択肢/);
    expect(validateTicketFields([{ id: "f_b", label: " ", type: "text", required: false, options: [] }]).f_b).toMatch(/項目名/);
    expect(validateTicketFields([{ id: "f_c", label: "所属", type: "text", required: false, options: [] }])).toEqual({});
    // server rejects duplicate options (400) — stop it here instead of an optimistic rollback
    expect(
      validateTicketFields([{ id: "f_d", label: "区分", type: "select", required: true, options: ["現地", "現地"] }]).f_d,
    ).toMatch(/重複/);
  });
});

describe("demo transport serves the tickets wire contract", () => {
  it("returns stopped, unpaid state with seeded types and non-zero stats", async () => {
    const s = await demoLpApi().getTickets();
    expect(s.enabled).toBe(false);
    expect(s.ctaEnabled).toBe(false);
    expect(s.paymentReady).toBe(false);
    expect(s.types.map((t) => `${t.name}|${t.dayLabel}`)).toEqual([
      "一般|Day 1 · 9/13(月)",
      "学生|Day 1 · 9/13(月)",
      "一般|Day 2 · 9/14(火)",
      "学生|Day 2 · 9/14(火)",
      "招待|",
    ]);
    expect(s.types.find((t) => t.name === "招待")!.capacity).toBeNull();
    expect(s.types.every((t) => t.maxPerOrder >= 1 && t.maxPerOrder <= 20)).toBe(true);
    expect(s.totals.sold).toBeGreaterThan(0);
    expect(s.totals.revenueJpy).toBe(s.types.reduce((n, t) => n + t.stats.revenueJpy, 0));
    expect(s.fields.map((f) => f.label)).toEqual(["所属", "参加区分"]);
  });

  it("creates a type, rejects 30 yen, and pages orders newest first", async () => {
    const api = demoLpApi();
    const created = await api.createTicketType({
      name: "早割",
      description: "",
      priceJpy: 2000,
      capacity: 50,
      dayLabel: "Day 1 · 9/13(月)",
      maxPerOrder: 4,
      active: true,
    });
    expect(created.stats.remaining).toBe(50);
    expect(created).toMatchObject({ dayLabel: "Day 1 · 9/13(月)", maxPerOrder: 4 });
    await expect(
      api.createTicketType({ name: "x", description: "", priceJpy: 30, capacity: null, dayLabel: "", maxPerOrder: 10, active: true }),
    ).rejects.toThrow();
    await expect(api.updateTicketType(created.id, { maxPerOrder: 21 })).rejects.toThrow();

    const p1 = await api.listTicketOrders({ limit: 5 });
    expect(p1.items).toHaveLength(5);
    expect(p1.items[0]!.createdAt >= p1.items[1]!.createdAt).toBe(true);
    const p2 = await api.listTicketOrders({ limit: 5, cursor: p1.nextCursor! });
    const p3 = await api.listTicketOrders({ limit: 5, cursor: p2.nextCursor! });
    expect(p3.nextCursor).toBeNull();
    expect(p1.items.length + p2.items.length + p3.items.length).toBe(11);
    // v2: an order carries several types x quantity; totals are consistent with its lines
    const all = [...p1.items, ...p2.items, ...p3.items];
    expect(all.some((o) => o.items.length > 1)).toBe(true);
    for (const o of all) {
      expect(o.quantity).toBe(o.items.reduce((n, it) => n + it.quantity, 0));
      expect(o.amountJpy).toBe(o.items.reduce((n, it) => n + it.unitPriceJpy * it.quantity, 0));
    }
  });

  it("counts sold / pending in tickets (not orders) and toggles ctaEnabled while sales are off", async () => {
    const api = demoLpApi();
    const s = await api.getTickets();
    const d1 = s.types.find((t) => t.id === "tt_general_d1")!;
    // paid: ord_003 x1 + ord_002 x5 + ord_001 x1 = 7 tickets; held: ord_008 x2 (pending) + ord_010 x1 (needs_review)
    expect(d1.stats).toMatchObject({ sold: 7, pending: 3, revenueJpy: 21000, remaining: 200 - 7 - 3 });
    await api.setTicketsEnabled({ enabled: false });
    const after = await api.setTicketsCta({ enabled: true });
    expect(after).toMatchObject({ enabled: false, ctaEnabled: true });
  });

  it("approves the seeded needs_review order once (then 409); it moves from held to sold", async () => {
    const api = demoLpApi();
    const approved = await api.approveTicketOrder("ord_010");
    expect(approved).toMatchObject({ status: "paid", reviewReason: "amount_mismatch" });
    await expect(api.approveTicketOrder("ord_010")).rejects.toThrow();
    const d1 = (await api.getTickets()).types.find((t) => t.id === "tt_general_d1")!;
    expect(d1.stats).toMatchObject({ sold: 8, pending: 2 });
  });
});

describe("LpTicketsScreen", () => {
  it("renders the summary tiles and the type row from the state", async () => {
    renderScreen(fakeApi());
    expect(screen.getByTestId("fe2-lp-tickets-loading")).toBeInTheDocument();
    expect(await screen.findByTestId("fe2-lp-tickets-sold")).toHaveTextContent("4 枚");
    expect(screen.getByTestId("fe2-lp-tickets-revenue")).toHaveTextContent("¥12,000");
    expect(screen.getByTestId("fe2-lp-tickets-payment")).toHaveTextContent("決済 未設定");
    expect(screen.getByTestId("fe2-lp-tickets-public-url")).toHaveAttribute("href", "https://hokuriku-it-conf.com/tickets");
    expect(screen.getByTestId("fe2-lp-ticket-type-sold-tt_general")).toHaveTextContent("4 / 195");
    expect(screen.getByTestId("fe2-lp-ticket-type-pending-tt_general")).toHaveTextContent("決済待ち 1 枚");
    expect(screen.getByTestId("fe2-lp-ticket-type-max-tt_general")).toHaveTextContent("最大 10 枚");
    // all types are undated -> one plain table, no day headings
    expect(screen.queryByTestId("fe2-lp-ticket-day-group-0")).not.toBeInTheDocument();
  });

  it("groups the type table by day label", async () => {
    const types = [
      ticketType({ id: "g1", dayLabel: "Day 1 · 9/13(月)", stats: { sold: 2, pending: 0, revenueJpy: 6000, remaining: 198 } }),
      ticketType({ id: "s1", name: "学生", priceJpy: 1000, dayLabel: "Day 1 · 9/13(月)", stats: { sold: 3, pending: 0, revenueJpy: 3000, remaining: 97 } }),
      ticketType({ id: "g2", dayLabel: "Day 2 · 9/14(火)", stats: { sold: 1, pending: 0, revenueJpy: 3000, remaining: 199 } }),
    ];
    renderScreen(fakeApi({ getTickets: () => Promise.resolve(baseState({ types })) }));
    const day1 = await screen.findByTestId("fe2-lp-ticket-day-group-0");
    expect(day1).toHaveTextContent("Day 1 · 9/13(月)");
    expect(within(day1).getByTestId("fe2-lp-ticket-day-group-total-0")).toHaveTextContent("販売 5 枚 · 売上 ¥9,000");
    expect(within(day1).getByTestId("fe2-lp-ticket-type-sold-s1")).toBeInTheDocument();
    const day2 = screen.getByTestId("fe2-lp-ticket-day-group-1");
    expect(within(day2).getByTestId("fe2-lp-ticket-type-sold-g2")).toBeInTheDocument();
    expect(within(day2).queryByTestId("fe2-lp-ticket-type-sold-g1")).not.toBeInTheDocument();
  });

  it("sends dayLabel and maxPerOrder when adding a type, offering existing day labels", async () => {
    const create = vi.fn((input: Parameters<LpApi["createTicketType"]>[0]) =>
      Promise.resolve(ticketType({ ...input, id: "tt_new", stats: { sold: 0, pending: 0, revenueJpy: 0, remaining: input.capacity } })),
    );
    const types = [ticketType({ id: "g1", dayLabel: "Day 1 · 9/13(月)" })];
    renderScreen(fakeApi({ getTickets: () => Promise.resolve(baseState({ types })), createTicketType: create }));
    fireEvent.click(await screen.findByTestId("fe2-lp-ticket-type-add"));
    const dialog = await screen.findByTestId("fe2-lp-ticket-type-dialog");
    expect(within(dialog).getByTestId("fe2-lp-ticket-type-max")).toHaveValue(10);
    fireEvent.change(within(dialog).getByTestId("fe2-lp-ticket-type-name"), { target: { value: "学生" } });
    fireEvent.change(within(dialog).getByTestId("fe2-lp-ticket-type-price"), { target: { value: "1000" } });
    fireEvent.click(within(dialog).getByTestId("fe2-lp-ticket-type-day-pick-0"));
    expect(within(dialog).getByTestId("fe2-lp-ticket-type-day")).toHaveValue("Day 1 · 9/13(月)");
    fireEvent.change(within(dialog).getByTestId("fe2-lp-ticket-type-max"), { target: { value: "4" } });
    fireEvent.click(within(dialog).getByTestId("fe2-lp-ticket-type-save"));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ name: "学生", priceJpy: 1000, dayLabel: "Day 1 · 9/13(月)", maxPerOrder: 4 });
  });

  it("renders the demo transport end to end (not a blank screen)", async () => {
    renderScreen(demoLpApi());
    expect(await screen.findByTestId("fe2-lp-ticket-types-table")).toHaveTextContent("学生");
    expect(screen.getByTestId("fe2-lp-tickets-payment")).toHaveTextContent("決済 未設定");
    await waitFor(() => expect(screen.getByTestId("fe2-lp-ticket-orders-list")).toBeInTheDocument());
  });

  it("disables the publish toggle without lp:publish", async () => {
    renderScreen(fakeApi(), EDITOR);
    const toggle = await screen.findByTestId("fe2-lp-tickets-enabled");
    expect(toggle).toBeDisabled();
    expect(screen.getByTestId("fe2-lp-tickets-enabled-hint")).toHaveTextContent("lp:publish");
  });

  it("confirms, flips optimistically and rolls back when the server refuses", async () => {
    let reject: (e: Error) => void = () => undefined;
    const api = fakeApi({
      setTicketsEnabled: () =>
        new Promise((_res, rej) => {
          reject = rej;
        }),
    });
    renderScreen(api);
    const toggle = await screen.findByTestId("fe2-lp-tickets-enabled");
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId("fe2-lp-tickets-enabled-dialog");
    expect(dialog).toHaveTextContent("チケットを購入");
    fireEvent.click(within(dialog).getByTestId("fe2-lp-tickets-enabled-ack"));
    fireEvent.click(within(dialog).getByTestId("fe2-lp-tickets-enabled-confirm"));

    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-enabled")).toBeChecked());
    reject(new Error("boom"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-enabled")).not.toBeChecked());
    expect(await screen.findByText("販売状態を切り替えられませんでした")).toBeInTheDocument();
  });

  it("publishing warns it goes public to everyone and needs the acknowledgement", async () => {
    const setEnabled = vi.fn(({ enabled }: { enabled: boolean }) => Promise.resolve(baseState({ enabled })));
    renderScreen(fakeApi({ setTicketsEnabled: setEnabled }));
    fireEvent.click(await screen.findByTestId("fe2-lp-tickets-enabled"));
    const dialog = await screen.findByTestId("fe2-lp-tickets-enabled-dialog");
    expect(within(dialog).getByTestId("fe2-lp-tickets-enabled-warning")).toHaveTextContent(
      "本当に全ユーザーに公開されますがよろしいですか？",
    );
    const confirm = within(dialog).getByTestId("fe2-lp-tickets-enabled-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(setEnabled).not.toHaveBeenCalled();

    // Cancel resets the acknowledgement for the next attempt.
    fireEvent.click(within(dialog).getByTestId("fe2-lp-tickets-enabled-ack"));
    expect(confirm).toBeEnabled();
    fireEvent.click(within(dialog).getByTestId("fe2-lp-tickets-enabled-cancel"));
    fireEvent.click(screen.getByTestId("fe2-lp-tickets-enabled"));
    const again = await screen.findByTestId("fe2-lp-tickets-enabled-dialog");
    expect(within(again).getByTestId("fe2-lp-tickets-enabled-confirm")).toBeDisabled();
    fireEvent.click(within(again).getByTestId("fe2-lp-tickets-enabled-ack"));
    fireEvent.click(within(again).getByTestId("fe2-lp-tickets-enabled-confirm"));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ enabled: true }));
  });

  it("stopping sales needs no acknowledgement", async () => {
    const setEnabled = vi.fn(({ enabled }: { enabled: boolean }) => Promise.resolve(baseState({ enabled })));
    renderScreen(fakeApi({ getTickets: () => Promise.resolve(baseState({ enabled: true })), setTicketsEnabled: setEnabled }));
    fireEvent.click(await screen.findByTestId("fe2-lp-tickets-enabled"));
    const dialog = await screen.findByTestId("fe2-lp-tickets-enabled-dialog");
    expect(within(dialog).queryByTestId("fe2-lp-tickets-enabled-ack")).toBeNull();
    fireEvent.click(within(dialog).getByTestId("fe2-lp-tickets-enabled-confirm"));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ enabled: false }));
  });

  it("blocks a 30 yen type before calling the api", async () => {
    const create = vi.fn(() => Promise.reject(new Error("should not be called")));
    renderScreen(fakeApi({ createTicketType: create }));
    fireEvent.click(await screen.findByTestId("fe2-lp-ticket-type-add"));
    const dialog = await screen.findByTestId("fe2-lp-ticket-type-dialog");
    fireEvent.change(within(dialog).getByTestId("fe2-lp-ticket-type-name"), { target: { value: "ワンコイン" } });
    fireEvent.change(within(dialog).getByTestId("fe2-lp-ticket-type-price"), { target: { value: "30" } });
    fireEvent.click(within(dialog).getByTestId("fe2-lp-ticket-type-save"));

    expect(await within(dialog).findByText(/50円以上/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("saves the whole field list in one request", async () => {
    const save = vi.fn(({ fields }: { fields: LpTicketsState["fields"] }) => Promise.resolve(baseState({ fields })));
    renderScreen(fakeApi({ saveTicketFields: save }));
    expect(await screen.findAllByTestId("fe2-lp-ticket-field-locked")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("fe2-lp-ticket-field-add"));
    const labels = screen.getAllByPlaceholderText("項目名（例: 所属）");
    const added = labels[labels.length - 1]!;
    fireEvent.change(added, { target: { value: "参加区分" } });
    const addedId = added.getAttribute("id")!.replace(/-label$/, "");
    fireEvent.change(screen.getByTestId(`${addedId}-type`), { target: { value: "select" } });
    fireEvent.change(screen.getByTestId(`${addedId}-options`), { target: { value: "現地\nオンライン\n" } });
    fireEvent.click(screen.getByTestId(`${addedId}-required`));
    fireEvent.click(screen.getByTestId("fe2-lp-ticket-fields-save"));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0]![0].fields;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ id: "f_aff", label: "所属" });
    expect(sent[1]).toMatchObject({ label: "参加区分", type: "select", required: true, options: ["現地", "オンライン"] });
    expect(sent[1]!.id).toMatch(/^f_[a-z0-9]+$/);
  });

  it("hides buyers and edit controls from a viewer", async () => {
    const orders = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
    renderScreen(fakeApi({ listTicketOrders: orders }), VIEWER);
    await screen.findByTestId("fe2-lp-ticket-types-table");
    expect(screen.queryByTestId("fe2-lp-ticket-orders")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-lp-ticket-type-add")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-lp-ticket-fields-save")).not.toBeInTheDocument();
    expect(orders).not.toHaveBeenCalled();
  });

  it("explains that the CTA swap waits for sales, and saves it without a dialog while sales are off", async () => {
    const cta = vi.fn(({ enabled }: { enabled: boolean }) => Promise.resolve(baseState({ ctaEnabled: enabled })));
    renderScreen(fakeApi({ setTicketsCta: cta }));
    expect(await screen.findByTestId("fe2-lp-tickets-cta-hint")).toHaveTextContent("販売を公開すると有効になります");
    const toggle = screen.getByTestId("fe2-lp-tickets-cta");
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("fe2-lp-tickets-cta-dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(cta).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-cta-state")).toHaveTextContent("販売の公開待ち"));
  });

  it("confirms the CTA swap while on sale, flips optimistically and rolls back on failure", async () => {
    let reject: (e: Error) => void = () => undefined;
    const api = fakeApi({
      getTickets: () => Promise.resolve(baseState({ enabled: true })),
      setTicketsCta: () =>
        new Promise((_res, rej) => {
          reject = rej;
        }),
    });
    renderScreen(api);
    const toggle = await screen.findByTestId("fe2-lp-tickets-cta");
    expect(screen.getByTestId("fe2-lp-tickets-cta-state")).toHaveTextContent("元の表示");
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId("fe2-lp-tickets-cta-dialog");
    expect(dialog).toHaveTextContent("参加チケットを購入");
    fireEvent.click(within(dialog).getByTestId("fe2-lp-tickets-cta-confirm"));

    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-cta")).toBeChecked());
    expect(screen.getByTestId("fe2-lp-tickets-cta-state")).toHaveTextContent("LP に反映中");
    reject(new Error("boom"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-cta")).not.toBeChecked());
    expect(await screen.findByText("参加登録ボタンの設定を切り替えられませんでした")).toBeInTheDocument();
  });

  it("disables the CTA toggle without lp:publish", async () => {
    renderScreen(fakeApi(), EDITOR);
    expect(await screen.findByTestId("fe2-lp-tickets-cta")).toBeDisabled();
  });

  it("lists each order as type x quantity with the total tickets and amount", async () => {
    const order: LpTicketOrder = {
      id: "ord_x",
      items: [
        { ticketTypeId: "g1", ticketTypeName: "一般", dayLabel: "Day 1 · 9/13(月)", unitPriceJpy: 3000, quantity: 2 },
        { ticketTypeId: "s2", ticketTypeName: "学生", dayLabel: "Day 2 · 9/14(火)", unitPriceJpy: 1000, quantity: 1 },
      ],
      quantity: 3,
      amountJpy: 7000,
      status: "paid",
      buyerName: "山田 太郎",
      buyerEmail: "y@example.com",
      answers: [],
      createdAt: "2026-10-12T11:20:00.000Z",
      paidAt: "2026-10-12T11:21:00.000Z",
      reviewReason: null,
      couponId: null,
    };
    renderScreen(fakeApi({ listTicketOrders: () => Promise.resolve({ items: [order], nextCursor: null }) }));
    const items = await screen.findByTestId("fe2-lp-ticket-order-items-ord_x");
    expect(items).toHaveTextContent("一般 · Day 1 · 9/13(月)");
    expect(items).toHaveTextContent("× 2");
    expect(items).toHaveTextContent("学生 · Day 2 · 9/14(火)");
    expect(screen.getByTestId("fe2-lp-ticket-order-total-ord_x")).toHaveTextContent("¥7,000");
    expect(screen.getByTestId("fe2-lp-ticket-order-total-ord_x")).toHaveTextContent("計 3 枚");
    fireEvent.click(screen.getByTestId("fe2-lp-ticket-order-details-ord_x"));
    expect(screen.getByTestId("fe2-lp-ticket-order-answers-ord_x")).toHaveTextContent("¥3,000 × 2 枚 = ¥6,000");
  });

  describe("needs_review orders", () => {
    function reviewOrder(over: Partial<LpTicketOrder> = {}): LpTicketOrder {
      return {
        id: "ord_r",
        items: [{ ticketTypeId: "g1", ticketTypeName: "一般", dayLabel: "", unitPriceJpy: 3000, quantity: 1 }],
        quantity: 1,
        amountJpy: 3000,
        status: "needs_review",
        buyerName: "佐藤 花子",
        buyerEmail: "s@example.com",
        answers: [],
        createdAt: "2026-10-12T11:20:00.000Z",
        paidAt: null,
        reviewReason: "oversold",
        couponId: null,
        ...over,
      };
    }

    it("shows the reason in plain words and the approve button only with lp:publish", async () => {
      const list = () => Promise.resolve({ items: [reviewOrder()], nextCursor: null });
      renderScreen(fakeApi({ listTicketOrders: list }));
      expect(await screen.findByTestId("fe2-lp-ticket-order-reason-ord_r")).toHaveTextContent("定員超過後に支払いが完了");
      expect(screen.getByTestId("fe2-lp-ticket-order-approve-ord_r")).toHaveTextContent("確認して確定する");
    });

    it("shows only the reason (no button) without lp:publish, and falls back for unknown reasons", async () => {
      const list = () => Promise.resolve({ items: [reviewOrder({ reviewReason: "something_new" })], nextCursor: null });
      renderScreen(fakeApi({ listTicketOrders: list }), EDITOR);
      expect(await screen.findByTestId("fe2-lp-ticket-order-reason-ord_r")).toHaveTextContent("要確認");
      expect(screen.queryByTestId("fe2-lp-ticket-order-approve-ord_r")).not.toBeInTheDocument();
    });

    it("confirms, calls approveTicketOrder and shows the row as paid", async () => {
      let current = reviewOrder();
      const approve = vi.fn((id: string) => {
        current = { ...current, status: "paid", paidAt: "2026-10-12T12:00:00.000Z" };
        return Promise.resolve({ ...current, id });
      });
      renderScreen(
        fakeApi({ listTicketOrders: () => Promise.resolve({ items: [current], nextCursor: null }), approveTicketOrder: approve }),
      );
      fireEvent.click(await screen.findByTestId("fe2-lp-ticket-order-approve-ord_r"));
      const dialog = await screen.findByTestId("fe2-lp-ticket-order-approve-dialog");
      expect(dialog).toHaveTextContent("Stripe ダッシュボードで入金額を確認してから確定してください");
      expect(dialog).toHaveTextContent("販売数・売上に入ります");
      expect(dialog).toHaveTextContent("自動で「返金済み」になり");
      fireEvent.click(within(dialog).getByTestId("fe2-lp-ticket-order-approve-confirm"));

      await waitFor(() => expect(approve).toHaveBeenCalledWith("ord_r"));
      const row = screen.getByTestId("fe2-lp-ticket-order-ord_r");
      await waitFor(() => expect(row).toHaveTextContent("支払い済み"));
      expect(screen.queryByTestId("fe2-lp-ticket-order-review-ord_r")).not.toBeInTheDocument();
    });

    it("flips optimistically and rolls back to 要確認 when the server refuses", async () => {
      let reject: (e: Error) => void = () => undefined;
      renderScreen(
        fakeApi({
          listTicketOrders: () => Promise.resolve({ items: [reviewOrder()], nextCursor: null }),
          approveTicketOrder: () =>
            new Promise((_res, rej) => {
              reject = rej;
            }),
        }),
      );
      fireEvent.click(await screen.findByTestId("fe2-lp-ticket-order-approve-ord_r"));
      fireEvent.click(within(await screen.findByTestId("fe2-lp-ticket-order-approve-dialog")).getByTestId("fe2-lp-ticket-order-approve-confirm"));

      await waitFor(() => expect(screen.getByTestId("fe2-lp-ticket-order-ord_r")).toHaveTextContent("支払い済み"));
      reject(new Error("boom"));
      await waitFor(() => expect(screen.getByTestId("fe2-lp-ticket-order-ord_r")).toHaveTextContent("要確認"));
      expect(screen.getByTestId("fe2-lp-ticket-order-approve-ord_r")).toBeInTheDocument();
      expect(await screen.findByText("注文を確定できませんでした")).toBeInTheDocument();
    });
  });

  it("shows a retryable error state when loading fails", async () => {
    renderScreen(fakeApi({ getTickets: () => Promise.reject(new Error("boom")) }));
    expect(await screen.findByTestId("fe2-lp-tickets-error")).toBeInTheDocument();
  });
});

function coupon(over: Partial<LpTicketCoupon> = {}): LpTicketCoupon {
  return {
    id: "cpn_a",
    code: "ABCDE23456",
    label: "登壇者向け",
    ticketTypeId: "tt_invite",
    maxUses: 5,
    used: 1,
    expiresAt: null,
    active: true,
    createdBy: "usr_1",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

const INVITE = ticketType({ id: "tt_invite", name: "招待", priceJpy: 0, capacity: null });

describe("coupons (pure)", () => {
  const now = new Date("2026-10-15T03:00:00Z"); // 12:00 JST

  it("derives one state: paused > expired > used up > active", () => {
    expect(couponState(coupon(), now)).toBe("active");
    expect(couponState(coupon({ used: 5 }), now)).toBe("used_up");
    expect(couponState(coupon({ used: 5, expiresAt: "2026-10-14T00:00:00Z" }), now)).toBe("expired");
    expect(couponState(coupon({ used: 5, expiresAt: "2026-10-14T00:00:00Z", active: false }), now)).toBe("paused");
  });

  it("validates the draft like the server (1..1000, label <= 60, expiry today or later as end of day JST)", () => {
    const d = { ticketTypeId: "tt_invite", maxUses: "3", label: " 登壇者 ", expiresOn: null };
    expect(validateCouponDraft(d, now).input).toEqual({ ticketTypeId: "tt_invite", maxUses: 3, label: "登壇者" });
    expect(validateCouponDraft({ ...d, maxUses: "0" }, now).errors.maxUses).toBeTruthy();
    expect(validateCouponDraft({ ...d, maxUses: "1001" }, now).errors.maxUses).toBeTruthy();
    expect(validateCouponDraft({ ...d, label: "x".repeat(61) }, now).errors.label).toMatch(/60文字/);
    expect(validateCouponDraft({ ...d, ticketTypeId: "" }, now).errors.ticketTypeId).toBeTruthy();
    expect(validateCouponDraft({ ...d, expiresOn: "2026-10-14" }, now).errors.expiresOn).toMatch(/今日以降/);
    expect(validateCouponDraft({ ...d, expiresOn: "2026-10-15" }, now).input?.expiresAt).toBe("2026-10-15T14:59:59.000Z");
    expect(validateCouponDraft({ ...d, label: "" }, now).input).not.toHaveProperty("label");
    expect(todayJst(new Date("2026-10-15T16:00:00Z"))).toBe("2026-10-16");
    expect(couponExpiryIso("2026-12-31")).toBe("2026-12-31T14:59:59.000Z");
  });
});

describe("demo transport serves the coupons contract", () => {
  it("seeds in-use / used-up / paused / expired coupons with used counted from orders", async () => {
    const { items } = await demoLpApi().listTicketCoupons();
    const by = new Map(items.map((c) => [c.id, c]));
    expect(items.map((c) => c.createdAt)).toEqual([...items.map((c) => c.createdAt)].sort().reverse());
    expect(couponState(by.get("cpn_speakers")!)).toBe("active");
    expect(by.get("cpn_speakers")!.used).toBe(1);
    expect(couponState(by.get("cpn_sponsor_a")!)).toBe("used_up");
    expect(couponState(by.get("cpn_staff")!)).toBe("paused");
    expect(couponState(by.get("cpn_press")!)).toBe("expired");
  });

  it("marks coupon orders with couponId at 0 yen", async () => {
    const api = demoLpApi();
    const { items } = await api.listTicketOrders({ limit: 100 });
    const couponOrders = items.filter((o) => o.couponId !== null);
    expect(couponOrders.length).toBeGreaterThan(0);
    expect(couponOrders.every((o) => o.amountJpy === 0)).toBe(true);
    expect(items.find((o) => o.id === "ord_011")).toMatchObject({ couponId: "cpn_speakers", status: "paid" });
  });

  it("issues a server-generated code, rejects bad input, and pauses / resumes", async () => {
    const api = demoLpApi();
    const created = await api.createTicketCoupon({ ticketTypeId: "tt_invite", maxUses: 2, label: "テスト" });
    expect(created.code).toMatch(/^[A-HJKMNP-Z2-9]{10}$/);
    expect(created).toMatchObject({ used: 0, active: true, expiresAt: null });
    expect((await api.listTicketCoupons()).items[0]!.id).toBe(created.id);
    await expect(api.createTicketCoupon({ ticketTypeId: "tt_invite", maxUses: 0 })).rejects.toThrow();
    await expect(api.createTicketCoupon({ ticketTypeId: "nope", maxUses: 1 })).rejects.toThrow();
    await expect(api.createTicketCoupon({ ticketTypeId: "tt_invite", maxUses: 1, expiresAt: "2020-01-01T00:00:00Z" })).rejects.toThrow();
    expect((await api.setTicketCouponActive(created.id, { active: false })).active).toBe(false);
    expect((await api.setTicketCouponActive(created.id, { active: true })).active).toBe(true);
  });
});

describe("LpTicketsScreen coupons", () => {
  const withInvite = () => Promise.resolve(baseState({ types: [ticketType(), INVITE] }));

  it("lists coupons with type, usage, expiry and a glanceable state", async () => {
    const list = () =>
      Promise.resolve({
        items: [
          coupon(),
          coupon({ id: "cpn_full", used: 5 }),
          coupon({ id: "cpn_old", expiresAt: "2026-01-01T00:00:00Z" }),
          coupon({ id: "cpn_off", active: false }),
          coupon({ id: "cpn_paid", ticketTypeId: "tt_general" }),
        ],
      });
    renderScreen(fakeApi({ getTickets: withInvite, listTicketCoupons: list }));
    expect(await screen.findByTestId("fe2-lp-coupon-code-cpn_a")).toHaveTextContent("ABCDE23456");
    expect(screen.getByTestId("fe2-lp-coupon-issue")).toHaveTextContent("クーポンを発行");
    expect(screen.getByTestId("fe2-lp-coupon-type-cpn_a")).toHaveTextContent("招待");
    expect(screen.getByTestId("fe2-lp-coupon-used-cpn_a")).toHaveTextContent("1 / 5");
    expect(screen.getByTestId("fe2-lp-coupon-expires-cpn_a")).toHaveTextContent("期限なし");
    expect(screen.getByTestId("fe2-lp-coupon-state-cpn_a")).toHaveTextContent("使用可");
    expect(screen.getByTestId("fe2-lp-coupon-state-cpn_full")).toHaveTextContent("上限に達した");
    expect(screen.getByTestId("fe2-lp-coupon-state-cpn_old")).toHaveTextContent("期限切れ");
    expect(screen.getByTestId("fe2-lp-coupon-state-cpn_off")).toHaveTextContent("停止中");
    expect(screen.getByTestId("fe2-lp-coupon-paid-type-cpn_paid")).toHaveTextContent("このコードなら無料");
    expect(screen.getByTestId("fe2-lp-coupon-toggle-cpn_off")).toHaveTextContent("再開する");
  });

  it("shows a skeleton while loading and an empty state with no coupons", async () => {
    let resolve: (v: { items: LpTicketCoupon[] }) => void = () => undefined;
    renderScreen(fakeApi({ listTicketCoupons: () => new Promise((r) => (resolve = r)) }));
    expect(await screen.findByTestId("fe2-lp-coupons-loading")).toBeInTheDocument();
    resolve({ items: [] });
    expect(await screen.findByTestId("fe2-lp-coupons-empty")).toBeInTheDocument();
  });

  it("does not fetch coupons without lp:publish and explains why", async () => {
    const list = vi.fn(() => Promise.resolve({ items: [coupon()] }));
    renderScreen(fakeApi({ listTicketCoupons: list }), EDITOR);
    expect(await screen.findByTestId("fe2-lp-coupons-publish-hint")).toHaveTextContent("lp:publish");
    expect(screen.queryByTestId("fe2-lp-coupon-issue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-lp-coupons")).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });

  it("hides the coupon section from a viewer", async () => {
    renderScreen(fakeApi(), VIEWER);
    await screen.findByTestId("fe2-lp-ticket-types-table");
    expect(screen.queryByTestId("fe2-lp-coupons")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-lp-coupons-locked")).not.toBeInTheDocument();
  });

  it("issues a coupon with the chosen type, count, memo and end-of-day expiry", async () => {
    const created = coupon({ id: "cpn_new", code: "NEWCQDE234", used: 0 });
    const stored: LpTicketCoupon[] = [];
    const create = vi.fn(() => {
      stored.unshift(created);
      return Promise.resolve(created);
    });
    renderScreen(fakeApi({ getTickets: withInvite, createTicketCoupon: create, listTicketCoupons: () => Promise.resolve({ items: [...stored] }) }));
    fireEvent.click(await screen.findByTestId("fe2-lp-coupon-issue"));
    const dialog = await screen.findByTestId("fe2-lp-coupon-dialog");
    // defaults to the free type, so no paid warning
    expect(within(dialog).getByTestId("fe2-lp-coupon-type")).toHaveValue("tt_invite");
    expect(within(dialog).queryByTestId("fe2-lp-coupon-paid-warning")).toBeNull();
    fireEvent.change(within(dialog).getByTestId("fe2-lp-coupon-max"), { target: { value: "10" } });
    fireEvent.change(within(dialog).getByTestId("fe2-lp-coupon-label"), { target: { value: "スポンサー B 社" } });
    fireEvent.change(within(dialog).getByTestId("fe2-lp-coupon-expires"), { target: { value: "2099-12-31" } });
    fireEvent.click(within(dialog).getByTestId("fe2-lp-coupon-save"));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({ ticketTypeId: "tt_invite", maxUses: 10, label: "スポンサー B 社", expiresAt: "2099-12-31T14:59:59.000Z" });
    expect(await screen.findByTestId("fe2-lp-coupon-code-cpn_new")).toHaveTextContent(created.code);
    await waitFor(() => expect(screen.queryByTestId("fe2-lp-coupon-dialog")).not.toBeInTheDocument());
  });

  it("warns that a coupon for a paid type makes it free, and blocks invalid counts before the api", async () => {
    const create = vi.fn(() => Promise.reject(new Error("should not be called")));
    renderScreen(fakeApi({ getTickets: withInvite, createTicketCoupon: create }));
    fireEvent.click(await screen.findByTestId("fe2-lp-coupon-issue"));
    const dialog = await screen.findByTestId("fe2-lp-coupon-dialog");
    fireEvent.change(within(dialog).getByTestId("fe2-lp-coupon-type"), { target: { value: "tt_general" } });
    expect(within(dialog).getByTestId("fe2-lp-coupon-paid-warning")).toHaveTextContent("0 円になり");
    fireEvent.change(within(dialog).getByTestId("fe2-lp-coupon-max"), { target: { value: "0" } });
    fireEvent.click(within(dialog).getByTestId("fe2-lp-coupon-save"));
    expect(await within(dialog).findByText(/1〜1,000/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("pauses optimistically and rolls back when the server refuses", async () => {
    let reject: (e: Error) => void = () => undefined;
    const toggle = vi.fn(
      () =>
        new Promise<LpTicketCoupon>((_res, rej) => {
          reject = rej;
        }),
    );
    renderScreen(fakeApi({ getTickets: withInvite, listTicketCoupons: () => Promise.resolve({ items: [coupon()] }), setTicketCouponActive: toggle }));
    fireEvent.click(await screen.findByTestId("fe2-lp-coupon-toggle-cpn_a"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-coupon-state-cpn_a")).toHaveTextContent("停止中"));
    expect(toggle).toHaveBeenCalledWith("cpn_a", { active: false });
    reject(new Error("boom"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-coupon-state-cpn_a")).toHaveTextContent("使用可"));
    expect(await screen.findByText("クーポンを停止できませんでした")).toBeInTheDocument();
  });

  it("does not offer resume for an expired paused coupon", async () => {
    const list = () => Promise.resolve({ items: [coupon({ active: false, expiresAt: "2026-01-01T00:00:00Z" })] });
    renderScreen(fakeApi({ getTickets: withInvite, listTicketCoupons: list }));
    expect(await screen.findByTestId("fe2-lp-coupon-state-cpn_a")).toHaveTextContent("停止中");
    expect(screen.queryByTestId("fe2-lp-coupon-toggle-cpn_a")).not.toBeInTheDocument();
  });

  it("badges coupon orders in the buyer list, with the code when lp:publish can read it", async () => {
    const order: LpTicketOrder = {
      id: "ord_c",
      items: [{ ticketTypeId: "tt_invite", ticketTypeName: "招待", dayLabel: "", unitPriceJpy: 0, quantity: 1 }],
      quantity: 1,
      amountJpy: 0,
      status: "paid",
      buyerName: "松本 蓮",
      buyerEmail: "m@example.com",
      answers: [],
      createdAt: "2026-10-14T03:00:00.000Z",
      paidAt: "2026-10-14T03:00:00.000Z",
      reviewReason: null,
      couponId: "cpn_a",
    };
    const orders = () => Promise.resolve({ items: [order], nextCursor: null });
    renderScreen(fakeApi({ listTicketOrders: orders, listTicketCoupons: () => Promise.resolve({ items: [coupon()] }) }));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-ticket-order-coupon-ord_c")).toHaveTextContent("クーポン ABCDE23456"));
  });

  it("badges coupon orders without the code for an editor lacking lp:publish", async () => {
    const order = {
      id: "ord_c",
      items: [{ ticketTypeId: "tt_invite", ticketTypeName: "招待", dayLabel: "", unitPriceJpy: 0, quantity: 1 }],
      quantity: 1,
      amountJpy: 0,
      status: "paid" as const,
      buyerName: "松本 蓮",
      buyerEmail: "m@example.com",
      answers: [],
      createdAt: "2026-10-14T03:00:00.000Z",
      paidAt: "2026-10-14T03:00:00.000Z",
      reviewReason: null,
      couponId: "cpn_a",
    };
    renderScreen(fakeApi({ listTicketOrders: () => Promise.resolve({ items: [order], nextCursor: null }) }), EDITOR);
    expect(await screen.findByTestId("fe2-lp-ticket-order-coupon-ord_c")).toHaveTextContent(/^クーポン$/);
  });

  it("explains that a 0 yen type is coupon-only while editing its price", async () => {
    renderScreen(fakeApi());
    fireEvent.click(await screen.findByTestId("fe2-lp-ticket-type-add"));
    const dialog = await screen.findByTestId("fe2-lp-ticket-type-dialog");
    expect(within(dialog).queryByTestId("fe2-lp-ticket-type-coupon-note")).toBeNull();
    fireEvent.change(within(dialog).getByTestId("fe2-lp-ticket-type-price"), { target: { value: "0" } });
    expect(within(dialog).getByTestId("fe2-lp-ticket-type-coupon-note")).toHaveTextContent("0 円の券種はクーポンコードでのみ申し込めます");
    fireEvent.change(within(dialog).getByTestId("fe2-lp-ticket-type-price"), { target: { value: "1000" } });
    expect(within(dialog).queryByTestId("fe2-lp-ticket-type-coupon-note")).toBeNull();
  });

  it("renders the seeded demo coupons end to end", async () => {
    renderScreen(demoLpApi());
    expect(await screen.findByTestId("fe2-lp-coupons-table")).toHaveTextContent("SPKR7Q2M9X");
    expect(screen.getByTestId("fe2-lp-coupon-state-cpn_sponsor_a")).toHaveTextContent("上限に達した");
    await waitFor(() => expect(screen.getByTestId("fe2-lp-ticket-order-coupon-ord_011")).toHaveTextContent("クーポン SPKR7Q2M9X"));
  });
});
