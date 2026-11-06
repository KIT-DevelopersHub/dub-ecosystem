// スポンサーのメール連携 (画面): メール画面の紐付け (SponsorMailLink)・詳細の履歴・「メールから日付を補完」ダイアログ・
// demo の送信 → 営業先が 初回連絡 + 日付 (REAL demo transport)。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { sponsor, type identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createSponsorApi, type SponsorApi } from "./sponsorApi.tsx";
import { SponsorApiProvider } from "./SponsorProvider.tsx";
import { SponsorLeadsScreen } from "./SponsorLeadsScreen.tsx";
import { SponsorMailLink, externalAddresses } from "./SponsorMailLink.tsx";
import { describeActivity } from "./LeadMailSection.tsx";
import { runMailBackfill } from "./mailSyncHooks.ts";
import { todayIso } from "./leads.ts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const ADMIN = editorPermissions("sponsor", ["sponsor:read", "sponsor:write", "sponsor:admin"]);
const WRITER = editorPermissions("sponsor", ["sponsor:read", "sponsor:write"]);
const VIEWER = viewerPermissions("sponsor", ["sponsor:read"]);

function lead(over: Partial<sponsor.SponsorLead> = {}): sponsor.SponsorLead {
  return {
    id: "lead_1", companyName: "株式会社北陸テック", industry: null, owner: null, contactName: null, contactRole: null, contactEmail: null,
    source: null, contactType: null, evidence: null, priority: null, plan: null, status: "未接触", firstContactOn: null, lastContactOn: null,
    proposedOn: null, agreedOn: null, nextAction: null, nextActionOn: null, expectedAmount: null, confidence: null, budgetPeriod: null, decisionPeriod: null, note: null,
    version: 1, createdBy: "usr_1" as sponsor.SponsorLead["createdBy"], createdByName: null,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...over,
  };
}

function renderWith(node: JSX.Element, api: SponsorApi, permissions: readonly identity.PermissionKey[] = ADMIN) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={permissions}>
          <SponsorApiProvider value={api}>{node}</SponsorApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const demoFetch = () => createDemoFetch();
const apiOver = (fetchImpl: typeof fetch) => createSponsorApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl }));

describe("SponsorMailLink (メール画面の紐付け)", () => {
  it("keeps only external counterparts, in order and without duplicates", () => {
    expect(externalAddresses(["suzuki@developershub.jp", "Yamada@A.jp", "yamada@a.jp", "b@b.jp", "not-an-address"])).toEqual(["yamada@a.jp", "b@b.jp"]);
  });

  it("links the thread's counterpart to a searched lead, then shows the company as linked", async () => {
    const leads = [lead(), lead({ id: "lead_2", companyName: "金沢クラウド合同会社" })];
    let links: sponsor.SponsorMailLink[] = [];
    const createMailLink = vi.fn(async (leadId: string, body: sponsor.CreateMailLinkRequest): Promise<sponsor.CreateMailLinkResponse> => {
      const link = { id: "mlink_1", leadId, address: body.address, threadId: body.threadId ?? null, createdBy: "usr_1" as never, createdByName: null, createdAt: "2026-11-06T00:00:00Z" };
      links = [link];
      return { link, lead: { ...leads[1]!, contactEmail: body.address, status: "初回連絡", firstContactOn: "2026-11-01", version: 2 } };
    });
    const api = {
      ...apiOver(demoFetch()),
      listLeads: async () => ({ leads }),
      listMailLinks: async () => ({ links }),
      createMailLink,
    } as SponsorApi;
    renderWith(<SponsorMailLink addresses={["suzuki@developershub.jp", "ceo@kanazawa.example.jp"]} threadId="thr_9" />, api, WRITER);

    fireEvent.click(await screen.findByTestId("fe2-sponsor-mail-link-menu-trigger"));
    fireEvent.change(screen.getByTestId("fe2-sponsor-mail-link-menu-search"), { target: { value: "金沢" } });
    fireEvent.click(await screen.findByTestId("fe2-sponsor-mail-link-option-lead_2"));

    await waitFor(() => expect(createMailLink).toHaveBeenCalledWith("lead_2", { address: "ceo@kanazawa.example.jp", threadId: "thr_9" }));
    expect((await screen.findByTestId("fe2-sponsor-mail-link-current")).textContent).toBe("金沢クラウド合同会社");
    expect(screen.getByTestId("fe2-sponsor-mail-link-how").textContent).toBe("紐付け済み");
    expect(await screen.findByText("「金沢クラウド合同会社」に紐付けました")).toBeTruthy();
  });

  it("shows an automatic match by contact email, and nothing for viewers or internal-only threads", async () => {
    const api = { ...apiOver(demoFetch()), listLeads: async () => ({ leads: [lead({ contactEmail: "yamada@hokuriku.example.jp" })] }), listMailLinks: async () => ({ links: [] }) } as SponsorApi;
    const { unmount } = renderWith(<SponsorMailLink addresses={["yamada@hokuriku.example.jp"]} threadId="t" />, api, WRITER);
    expect((await screen.findByTestId("fe2-sponsor-mail-link-how")).textContent).toBe("担当者メールと一致");
    unmount();
    const viewer = renderWith(<SponsorMailLink addresses={["yamada@hokuriku.example.jp"]} threadId="t" />, api, VIEWER);
    expect(viewer.container.querySelector("[data-testid='fe2-sponsor-mail-link']")).toBeNull();
    viewer.unmount();
    const internal = renderWith(<SponsorMailLink addresses={["a@developershub.jp"]} threadId="t" />, api, WRITER);
    expect(internal.container.querySelector("[data-testid='fe2-sponsor-mail-link']")).toBeNull();
  });

  it("renders nothing outside the sponsor provider (mail tests / other shells)", () => {
    const client = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <FakeAuthProvider permissions={WRITER}>
          <SponsorMailLink addresses={["a@x.example.jp"]} threadId="t" />
        </FakeAuthProvider>
      </QueryClientProvider>,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("メールから日付を補完 (ダイアログ)", () => {
  it("is offered to admins only", async () => {
    const { unmount } = renderWith(<SponsorLeadsScreen />, apiOver(demoFetch()), WRITER);
    await screen.findByTestId("fe2-sponsor-leads-table");
    expect(screen.queryByTestId("fe2-sponsor-lead-backfill-open")).toBeNull();
    unmount();
    renderWith(<SponsorLeadsScreen />, apiOver(demoFetch()), ADMIN);
    expect(await screen.findByTestId("fe2-sponsor-lead-backfill-open")).toBeTruthy();
  });

  it("shows the dry-run diff first, then applies it (demo transport)", async () => {
    const api = apiOver(demoFetch());
    renderWith(<SponsorLeadsScreen />, api, ADMIN);
    fireEvent.click(await screen.findByTestId("fe2-sponsor-lead-backfill-open"));
    const table = await screen.findByTestId("fe2-sponsor-backfill-table");
    const companies = within(table).getAllByTestId("fe2-sponsor-backfill-company").map((e) => e.textContent);
    expect(companies).toEqual(expect.arrayContaining(["能美ロボティクス株式会社", "加賀データサービス株式会社"]));
    // 確認の段階では保存しない。
    expect((await api.getLead("lead_demo_11")).firstContactOn).toBeNull();
    fireEvent.click(screen.getByTestId("fe2-sponsor-backfill-apply"));
    expect(await screen.findByText(/社の日付を補完しました/)).toBeTruthy();
    const filled = await api.getLead("lead_demo_11");
    expect(filled.firstContactOn).not.toBeNull();
    expect(filled.status).toBe("返信あり");
    // もう一度開くと補完するものは無い。
    fireEvent.click(screen.getByTestId("fe2-sponsor-lead-backfill-open"));
    expect(await screen.findByTestId("fe2-sponsor-backfill-empty")).toBeTruthy();
  });

  it("walks every page until nextOffset is null", async () => {
    const calls: sponsor.MailBackfillRequest[] = [];
    const api = {
      mailBackfill: async (body: sponsor.MailBackfillRequest): Promise<sponsor.MailBackfillResponse> => {
        calls.push(body);
        const offset = body.offset ?? 0;
        const proposal = { leadId: `l${offset}`, companyName: `企業${offset}`, matchedBy: "email" as const, changes: [], evidence: [] };
        return { dryRun: body.dryRun, offset, limit: 50, total: 120, nextOffset: offset + 50 < 120 ? offset + 50 : null, proposals: [proposal] };
      },
    } as unknown as SponsorApi;
    const progress: number[] = [];
    const out = await runMailBackfill(api, true, (done) => progress.push(done));
    expect(calls.map((c) => c.offset)).toEqual([0, 50, 100]);
    expect(out.map((p) => p.leadId)).toEqual(["l0", "l50", "l100"]);
    expect(progress).toEqual([50, 100, 120]);
  });
});

describe("demo: メールを送ると営業進捗が進む", () => {
  it("sending to a 未接触 lead's contact makes it 初回連絡 with today's date, counted in this month's goals, with history", async () => {
    const fetchImpl = demoFetch();
    const api = apiOver(fetchImpl);
    const before = await api.getLead("lead_demo_8");
    expect(before).toMatchObject({ status: "未接触", firstContactOn: null });
    const res = await fetchImpl("https://demo.local/api/v1/mail/outbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: [{ email: "info@wajima-media.example.jp" }], subject: "協賛のご相談", textBody: "はじめまして" }),
    });
    expect(res.ok).toBe(true);
    const after = await api.getLead("lead_demo_8");
    expect(after).toMatchObject({ status: "初回連絡", firstContactOn: todayIso(), lastContactOn: todayIso(), version: before.version + 1 });
    const { activity } = await api.listLeadActivity("lead_demo_8");
    expect(activity).toHaveLength(1);
    const d = describeActivity(activity[0]!);
    expect(d.title).toMatch(/^メールから自動更新: .* 送信$/);
    expect(d.route).toContain("info@wajima-media.example.jp");
    expect(d.changes.join("、")).toContain("ステータス 未接触 → 初回連絡");
  });

  it("linking the ACME sender in the demo inbox fills that lead from past mail", async () => {
    const api = apiOver(demoFetch());
    const res = await api.createMailLink("lead_demo_9", { address: "sponsor@acme.co.jp", threadId: "thr_2" });
    expect(res.lead).toMatchObject({ contactEmail: "sponsor@acme.co.jp", status: "返信あり" });
    expect(res.lead.firstContactOn).not.toBeNull();
    expect((await api.listMailLinks()).links.map((l) => l.address)).toEqual(["sponsor@acme.co.jp"]);
  });
});
