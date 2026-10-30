// LP管理 → チケット のテスト。
//   (1) lpTickets の純粋関数（券種/入力項目の検証が契約と一致すること）
//   (2) demo transport がチケットのワイヤ契約に応答すること（REAL api-client 経由）
//   (3) LpTicketsScreen: 状態から集計を描画 / 公開トグルは lp:publish 必須 / 楽観更新の
//       ロールバック / 券種追加の検証 / 入力項目の一括保存 / 購入者は編集者だけ
//   v2: 対象日（dayLabel）でのグルーピング / 1 回の購入上限 / 参加登録ボタン差し替え（ctaEnabled）/
//       1 注文 = 複数券種 × 枚数
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createLpApi, type LpApi, type LpTicketOrder, type LpTicketsState, type LpTicketTypeSummary } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { LpTicketsScreen } from "./LpTicketsScreen.tsx";
import {
  groupTicketTypesByDay,
  paymentMethodLabel,
  paymentMethodsLabel,
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
    createTicketPreviewToken: unused,
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

describe("payment method labels", () => {
  it("maps Stripe types to display names; older APIs default to card", () => {
    expect(paymentMethodLabel("paypay")).toBe("PayPay");
    expect(paymentMethodLabel("card")).toBe("カード");
    expect(paymentMethodLabel("konbini")).toBe("konbini");
    expect(paymentMethodLabel(null)).toBe("");
    expect(paymentMethodsLabel(["card", "paypay"])).toBe("カード / PayPay");
    expect(paymentMethodsLabel(undefined)).toBe("カード");
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
    expect(p2.nextCursor).toBeNull();
    expect(p1.items.length + p2.items.length).toBe(8);
    // v2: an order carries several types x quantity; totals are consistent with its lines
    const all = [...p1.items, ...p2.items];
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
    // paid: ord_003 x1 + ord_002 x5 + ord_001 x1 = 7 tickets; pending: ord_008 x2
    expect(d1.stats).toMatchObject({ sold: 7, pending: 2, revenueJpy: 21000, remaining: 200 - 7 - 2 });
    await api.setTicketsEnabled({ enabled: false });
    const after = await api.setTicketsCta({ enabled: true });
    expect(after).toMatchObject({ enabled: false, ctaEnabled: true });
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
    // older API without paymentMethod: no method label
    expect(screen.queryByTestId("fe2-lp-ticket-order-method-ord_x")).not.toBeInTheDocument();
  });

  it("shows the payment method of a paid order (PayPay / カード)", async () => {
    const base: LpTicketOrder = {
      id: "ord_pp",
      items: [{ ticketTypeId: "g1", ticketTypeName: "一般", dayLabel: "", unitPriceJpy: 3000, quantity: 1 }],
      quantity: 1,
      amountJpy: 3000,
      status: "paid",
      buyerName: "山田 太郎",
      buyerEmail: "y@example.com",
      answers: [],
      createdAt: "2026-10-12T11:20:00.000Z",
      paidAt: "2026-10-12T11:21:00.000Z",
      paymentMethod: "paypay",
    };
    const items = [base, { ...base, id: "ord_card", paymentMethod: "card" }, { ...base, id: "ord_pend", status: "pending" as const, paidAt: null, paymentMethod: null }];
    renderScreen(fakeApi({ listTicketOrders: () => Promise.resolve({ items, nextCursor: null }) }));
    expect(await screen.findByTestId("fe2-lp-ticket-order-method-ord_pp")).toHaveTextContent("PayPay");
    expect(screen.getByTestId("fe2-lp-ticket-order-method-ord_card")).toHaveTextContent("カード");
    expect(screen.queryByTestId("fe2-lp-ticket-order-method-ord_pend")).not.toBeInTheDocument();
  });

  it("marks test orders (preview / Stripe test mode) so they are not mistaken for real sales", async () => {
    const base: LpTicketOrder = {
      id: "ord_t1",
      items: [{ ticketTypeId: "g1", ticketTypeName: "一般", dayLabel: "", unitPriceJpy: 3000, quantity: 1 }],
      quantity: 1,
      amountJpy: 3000,
      status: "paid",
      buyerName: "テスト",
      buyerEmail: "t@example.com",
      answers: [],
      createdAt: "2026-10-12T11:20:00.000Z",
      paidAt: "2026-10-12T11:21:00.000Z",
      preview: true,
      test: true,
    };
    const items = [base, { ...base, id: "ord_t2", preview: false }, { ...base, id: "ord_real", preview: false, test: false }];
    renderScreen(fakeApi({ listTicketOrders: () => Promise.resolve({ items, nextCursor: null }) }));
    expect(await screen.findByTestId("fe2-lp-ticket-order-test-ord_t1")).toHaveTextContent("テスト（プレビュー）");
    expect(screen.getByTestId("fe2-lp-ticket-order-test-ord_t2")).toHaveTextContent(/^テスト$/);
    expect(screen.queryByTestId("fe2-lp-ticket-order-test-ord_real")).not.toBeInTheDocument();
  });

  it("lists the advertised payment methods once Stripe is connected", async () => {
    renderScreen(fakeApi({ getTickets: () => Promise.resolve(baseState({ paymentReady: true, paymentMethods: ["card", "paypay"] })) }));
    expect(await screen.findByTestId("fe2-lp-tickets-payment-methods")).toHaveTextContent("支払い方法: カード / PayPay");
  });

  it("shows a retryable error state when loading fails", async () => {
    renderScreen(fakeApi({ getTickets: () => Promise.reject(new Error("boom")) }));
    expect(await screen.findByTestId("fe2-lp-tickets-error")).toBeInTheDocument();
  });
});
