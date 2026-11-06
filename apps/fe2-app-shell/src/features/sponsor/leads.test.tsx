// スポンサー営業進捗のテスト。
//   (1) 集計 = スプレッドシートと同じ数え方 / 並べ替え / 期限
//   (2) 貼り付けの解釈: 見出しで列を対応付け・引用セル・日付/金額・読めない値・重複行
//   (3) 画面: 集計・絞り込み・権限の出し分け・ステータスの楽観更新と 409・取り込みの流れ (REAL demo transport)
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { sponsor, type identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { ApiError, createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createSponsorApi, type SponsorApi } from "./sponsorApi.tsx";
import { SponsorApiProvider } from "./SponsorProvider.tsx";
import { SponsorLeadsScreen } from "./SponsorLeadsScreen.tsx";
import { isOverdue, sortLeads, summarizeLeads, todayIso } from "./leads.ts";
import { parseAmount, parseDate, parseLeadSheet, parseTsv } from "./leadImport.ts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const ADMIN = editorPermissions("sponsor", ["sponsor:read", "sponsor:write", "sponsor:admin"]);
const WRITER = editorPermissions("sponsor", ["sponsor:read", "sponsor:write"]);
const VIEWER = viewerPermissions("sponsor", ["sponsor:read"]);

function lead(over: Partial<sponsor.SponsorLead> = {}): sponsor.SponsorLead {
  return {
    id: "lead_1", companyName: "株式会社北陸テック", industry: null, owner: "吉岡", contactName: null, contactRole: null, contactEmail: null,
    source: null, contactType: null, evidence: null, priority: null, plan: null, status: "未接触", firstContactOn: null, lastContactOn: null,
    nextAction: null, nextActionOn: null, expectedAmount: null, confidence: null, budgetPeriod: null, decisionPeriod: null, note: null,
    version: 1, createdBy: "usr_1" as sponsor.SponsorLead["createdBy"], createdByName: "鈴木 一郎",
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...over,
  };
}

function renderScreen(api: SponsorApi, permissions: readonly identity.PermissionKey[] = ADMIN) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={permissions}>
          <SponsorApiProvider value={api}>
            <SponsorLeadsScreen />
          </SponsorApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const demoApi = () => createSponsorApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
const names = () => screen.queryAllByTestId("fe2-sponsor-lead-name").map((el) => el.textContent);

describe("集計と並べ替え", () => {
  it("counts like the spreadsheet: 接触済 includes 見送り, 提案済 includes everything after it", () => {
    const of = (...s: sponsor.LeadStatus[]) => s.map((status) => ({ status }));
    expect(summarizeLeads(of("未接触", "未接触", "初回連絡", "提案予定", "見送り", "提案済", "社内検討", "条件調整", "内諾", "契約済"))).toEqual({
      total: 10, contacted: 8, proposed: 5, agreed: 2,
    });
    expect(summarizeLeads([])).toEqual({ total: 0, contacted: 0, proposed: 0, agreed: 0 });
  });

  it("sorts by progress with 見送り last, and blanks last in either direction", () => {
    const rows = [
      lead({ id: "a", companyName: "A", status: "見送り" }),
      lead({ id: "b", companyName: "B", status: "内諾", nextActionOn: "2026-12-01" }),
      lead({ id: "c", companyName: "C", status: "未接触", nextActionOn: "2026-11-01" }),
    ];
    expect(sortLeads(rows, "status", "desc").map((l) => l.id)).toEqual(["b", "c", "a"]);
    expect(sortLeads(rows, "nextActionOn", "asc").map((l) => l.id)).toEqual(["c", "b", "a"]);
    expect(sortLeads(rows, "nextActionOn", "desc").map((l) => l.id)).toEqual(["b", "c", "a"]);
  });

  it("flags only open leads past their next action date", () => {
    expect(isOverdue({ status: "提案済", nextActionOn: "2026-11-05" }, "2026-11-06")).toBe(true);
    expect(isOverdue({ status: "提案済", nextActionOn: "2026-11-06" }, "2026-11-06")).toBe(false);
    expect(isOverdue({ status: "見送り", nextActionOn: "2026-11-05" }, "2026-11-06")).toBe(false);
    expect(isOverdue({ status: "提案済", nextActionOn: null }, "2026-11-06")).toBe(false);
  });

  it("uses the local calendar day", () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});

describe("貼り付けの解釈", () => {
  it("keeps tabs and newlines inside quoted cells and escaped quotes", () => {
    expect(parseTsv('a\t"x\ny"\tb\n"say ""hi"""\t\tc')).toEqual([
      ["a", "x\ny", "b"],
      ['say "hi"', "", "c"],
    ]);
    // 値の途中や閉じていない " はそのまま。
    expect(parseTsv('5" monitor\tb\n"open\tc')).toEqual([['5" monitor', "b"], ['"open', "c"]]);
  });

  it("parses dates and yen", () => {
    expect(parseDate("2026/9/1")).toBe("2026-09-01");
    expect(parseDate("2026-09-01")).toBe("2026-09-01");
    expect(parseDate("9/1")).toBeNull();
    expect(parseDate("2026/02/31")).toBeNull();
    expect(parseAmount("¥300,000")).toBe(300000);
    expect(parseAmount("300000円")).toBe(300000);
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount("相談")).toBeNull();
  });

  it("maps columns by header (optional suffix included), ignores unknown columns and blank rows", () => {
    const sheet = [
      ["No.", "ステータス", "企業名", "想定協賛額（任意）", "担当者メール（業務用）", "次回アクション日", "謎の列"].join("\t"),
      ["1", "内諾", "株式会社A", "¥100,000", "a@example.jp／b@example.jp（CC）", "2026/11/30", "x"].join("\t"),
      ["2", "", "", "", "", "", ""].join("\t"),
      ["", "未接触", "B", "", "", "なし", ""].join("\t"),
    ].join("\n");
    const { leads, noHeader, warnings } = parseLeadSheet(sheet);
    expect(noHeader).toBe(false);
    expect(warnings).toEqual([]);
    expect(leads).toEqual([
      { status: "内諾", companyName: "株式会社A", expectedAmount: 100000, contactEmail: "a@example.jp／b@example.jp（CC）", nextActionOn: "2026-11-30" },
      { status: "未接触", companyName: "B" },
    ]);
  });

  it("blanks unreadable values with a warning, keeping the row", () => {
    const sheet = "企業名\tステータス\t検討プラン\t初回連絡日\nA\t商談中\tDiamond\t来週";
    const { leads, warnings } = parseLeadSheet(sheet);
    expect(leads).toEqual([{ companyName: "A" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ステータス「商談中」");
    expect(warnings[0]).toContain("検討プラン「Diamond」");
    expect(warnings[0]).toContain("初回連絡日「来週」");
  });

  it("reports a missing header", () => {
    expect(parseLeadSheet("A\tB\nC\tD").noHeader).toBe(true);
  });
});

describe("営業タブ", () => {
  it("shows the summary, filters by status, and opens the detail", async () => {
    renderScreen(demoApi());
    expect(await screen.findByTestId("fe2-sponsor-leads-table")).toBeTruthy();
    expect(screen.getByTestId("fe2-sponsor-lead-stat-total").textContent).toBe("10");
    expect(screen.getByTestId("fe2-sponsor-lead-stat-contacted").textContent).toBe("8");
    expect(screen.getByTestId("fe2-sponsor-lead-stat-proposed").textContent).toBe("3");
    expect(screen.getByTestId("fe2-sponsor-lead-stat-agreed").textContent).toBe("1");
    // 既定は進んでいる順 (見送りは最後)。
    expect(names()[0]).toBe("金沢クラウド合同会社");
    expect(names().at(-1)).toBe("松任システムズ株式会社");
    expect(screen.getAllByText("期限切れ").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("fe2-sponsor-lead-filter-status-見送り"));
    expect(names()).toEqual(["松任システムズ株式会社"]);
    fireEvent.click(screen.getByTestId("fe2-sponsor-leads-filter-clear"));

    fireEvent.click(screen.getByTestId("fe2-sponsor-lead-lead_demo_1"));
    const detail = await screen.findByTestId("fe2-sponsor-lead-detail");
    expect(within(detail).getByText("¥300,000")).toBeTruthy();
  });

  it("links a lead to the business cards of the same company (表記ゆれ込み)", async () => {
    renderScreen(demoApi());
    fireEvent.click(await screen.findByTestId("fe2-sponsor-lead-lead_demo_1"));
    expect(within(await screen.findByTestId("fe2-sponsor-lead-cards")).getAllByRole("button").length).toBe(2);
  });

  it("hides editing from viewers and delete from writers", async () => {
    const api = createSponsorApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
    const { unmount } = renderScreen(api, VIEWER);
    fireEvent.click(await screen.findByTestId("fe2-sponsor-lead-lead_demo_1"));
    await screen.findByTestId("fe2-sponsor-lead-detail");
    expect(screen.queryByTestId("fe2-sponsor-lead-add")).toBeNull();
    expect(screen.queryByTestId("fe2-sponsor-lead-import-open")).toBeNull();
    expect(screen.queryByTestId("fe2-sponsor-lead-edit")).toBeNull();
    expect(screen.queryByTestId("fe2-sponsor-lead-status-lead_demo_1")).toBeNull();
    unmount();
    renderScreen(api, WRITER);
    fireEvent.click(await screen.findByTestId("fe2-sponsor-lead-lead_demo_1"));
    expect(await screen.findByTestId("fe2-sponsor-lead-edit")).toBeTruthy();
    expect(screen.queryByTestId("fe2-sponsor-lead-remove")).toBeNull();
  });

  it("changes the status optimistically and rolls back with a notice on 409", async () => {
    let reject!: (e: unknown) => void;
    const api: SponsorApi = {
      ...demoApi(),
      listLeads: () => Promise.resolve({ leads: [lead()] }),
      getLead: () => Promise.resolve(lead({ status: "返信あり", version: 2 })),
      updateLead: () => new Promise((_, r) => (reject = r)),
    };
    renderScreen(api);
    const select = (await screen.findByTestId("fe2-sponsor-lead-status-lead_1")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "初回連絡" } });
    await waitFor(() => expect(screen.getByTestId("fe2-sponsor-lead-stat-contacted").textContent).toBe("1"));
    await act(async () => reject(new ApiError(409, { error: { code: "SPONSOR_VERSION_CONFLICT", message: "x", retryable: false } } as never)));
    expect(await screen.findByText("他の人が更新しました")).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId("fe2-sponsor-lead-status-lead_1") as HTMLSelectElement).value).toBe("返信あり"));
  });

  it("adds a company through the form, and requires a name", async () => {
    renderScreen(demoApi());
    fireEvent.click(await screen.findByTestId("fe2-sponsor-lead-add"));
    const save = (await screen.findByTestId("fe2-sponsor-lead-create-save")) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("fe2-sponsor-lead-field-companyName"), { target: { value: "新規テスト株式会社" } });
    fireEvent.change(screen.getByTestId("fe2-sponsor-lead-field-expectedAmount"), { target: { value: "相談" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("fe2-sponsor-lead-field-expectedAmount"), { target: { value: "¥50,000" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(names()).toContain("新規テスト株式会社"));
    await waitFor(() => expect(screen.getByTestId("fe2-sponsor-lead-stat-total").textContent).toBe("11"));
  });

  it("imports a pasted sheet: previews, skips registered companies, then adds to the table", async () => {
    renderScreen(demoApi());
    fireEvent.click(await screen.findByTestId("fe2-sponsor-lead-import-open"));
    const text = await screen.findByTestId("fe2-sponsor-lead-import-text");
    const submit = screen.getByTestId("fe2-sponsor-lead-import-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(text, { target: { value: "見出しなし" } });
    expect(screen.getByTestId("fe2-sponsor-lead-import-noheader")).toBeTruthy();

    fireEvent.change(text, {
      target: { value: "企業名\tステータス\t検討プラン\n（株）北陸テック\t未接触\t\n輪島取り込み株式会社\t提案済\tDiamond\n能美取り込み株式会社\t初回連絡\t\n" },
    });
    const preview = screen.getByTestId("fe2-sponsor-lead-import-preview");
    expect(preview.textContent).toContain("2 社を追加します");
    expect(preview.textContent).toContain("登録済みの 1 社は飛ばします");
    expect(screen.getByTestId("fe2-sponsor-lead-import-warnings").textContent).toContain("Diamond");

    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId("fe2-sponsor-lead-stat-total").textContent).toBe("12"));
    expect(names()).toContain("輪島取り込み株式会社");
    expect(await screen.findByText("2 社を取り込みました")).toBeTruthy();
  });

  it("offers import from the empty state for a team starting from the spreadsheet", async () => {
    renderScreen({ ...demoApi(), listLeads: () => Promise.resolve({ leads: [] }) });
    expect(await screen.findByTestId("fe2-sponsor-leads-empty")).toBeTruthy();
    expect(screen.getByTestId("fe2-sponsor-lead-import-open")).toBeTruthy();
    expect(screen.queryByTestId("fe2-sponsor-lead-stats")).toBeNull();
  });
});
