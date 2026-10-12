// LP管理 → チケット のテスト。
//   (1) lpTickets の純粋関数（券種/入力項目の検証が契約と一致すること）
//   (2) demo transport がチケットのワイヤ契約に応答すること（REAL api-client 経由）
//   (3) LpTicketsScreen: 状態から集計を描画 / 公開トグルは lp:publish 必須 / 楽観更新の
//       ロールバック / 券種追加の検証 / 入力項目の一括保存 / 購入者は編集者だけ
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createLpApi, type LpApi, type LpTicketsState } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { LpTicketsScreen } from "./LpTicketsScreen.tsx";
import { validateTicketFields, validateTicketType } from "./lpTickets.ts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const PUBLISHER = editorPermissions("lp", ["lp:publish"]);
const EDITOR = editorPermissions("lp");
const VIEWER = viewerPermissions("lp");

function demoLpApi(): LpApi {
  return createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
}

function baseState(over: Partial<LpTicketsState> = {}): LpTicketsState {
  return {
    site: "hokuriku-it-conf.com",
    enabled: false,
    paymentReady: false,
    publicUrl: "https://hokuriku-it-conf.com/tickets",
    fields: [{ id: "f_aff", label: "所属", type: "text", required: false, options: [] }],
    types: [
      {
        id: "tt_general",
        name: "一般",
        description: "",
        priceJpy: 3000,
        capacity: 200,
        active: true,
        sortOrder: 0,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
        stats: { sold: 4, pending: 1, revenueJpy: 12000, remaining: 195 },
      },
    ],
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
    saveTicketFields: ({ fields }) => Promise.resolve(baseState({ fields })),
    createTicketType: unused,
    updateTicketType: unused,
    listTicketOrders: () => Promise.resolve({ items: [], nextCursor: null }),
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
  const draft = { name: "学生", description: "", price: "1000", capacity: "", active: true };

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
  it("returns published-but-unpaid state with seeded types and non-zero stats", async () => {
    const s = await demoLpApi().getTickets();
    expect(s.enabled).toBe(true);
    expect(s.paymentReady).toBe(false);
    expect(s.types.map((t) => t.name)).toEqual(["一般", "学生", "招待"]);
    expect(s.types.find((t) => t.name === "招待")!.capacity).toBeNull();
    expect(s.totals.sold).toBeGreaterThan(0);
    expect(s.totals.revenueJpy).toBe(s.types.reduce((n, t) => n + t.stats.revenueJpy, 0));
    expect(s.fields.map((f) => f.label)).toEqual(["所属", "参加区分"]);
  });

  it("creates a type, rejects 30 yen, and pages orders newest first", async () => {
    const api = demoLpApi();
    const created = await api.createTicketType({ name: "早割", description: "", priceJpy: 2000, capacity: 50, active: true });
    expect(created.stats.remaining).toBe(50);
    await expect(api.createTicketType({ name: "x", description: "", priceJpy: 30, capacity: null, active: true })).rejects.toThrow();

    const p1 = await api.listTicketOrders({ limit: 5 });
    expect(p1.items).toHaveLength(5);
    expect(p1.items[0]!.createdAt >= p1.items[1]!.createdAt).toBe(true);
    const p2 = await api.listTicketOrders({ limit: 5, cursor: p1.nextCursor! });
    expect(p2.nextCursor).toBeNull();
    expect(p1.items.length + p2.items.length).toBe(8);
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
    fireEvent.click(within(dialog).getByTestId("fe2-lp-tickets-enabled-confirm"));

    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-enabled")).toBeChecked());
    reject(new Error("boom"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-enabled")).not.toBeChecked());
    expect(await screen.findByText("販売状態を切り替えられませんでした")).toBeInTheDocument();
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

  it("shows a retryable error state when loading fails", async () => {
    renderScreen(fakeApi({ getTickets: () => Promise.reject(new Error("boom")) }));
    expect(await screen.findByTestId("fe2-lp-tickets-error")).toBeInTheDocument();
  });
});
