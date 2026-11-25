// スポンサーのメール連携 (画面): メール画面の「担当者メールに登録」(SponsorMailLink)・詳細の履歴・「メールから日付を補完」ダイアログ・
// demo の送信 → 登録したアドレス (名刺・担当者メール) なら 初回連絡 + 日付、未登録なら変化なし (REAL demo transport)。
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

function card(over: Partial<sponsor.BusinessCard> = {}): sponsor.BusinessCard {
  return {
    id: "card_1", companyName: "株式会社北陸テック", personName: "川口 恵", department: null, title: null, email: "kawaguchi@hokuriku.example.jp",
    phone: null, note: null, hasImage: false, version: 1, createdBy: "usr_1" as sponsor.BusinessCard["createdBy"], createdByName: null,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...over,
  };
}

describe("SponsorMailLink (メール画面: 担当者メールに登録)", () => {
  it("keeps only external counterparts, in order and without duplicates", () => {
    expect(externalAddresses(["suzuki@developershub.jp", "Yamada@A.jp", "yamada@a.jp", "b@b.jp", "not-an-address"])).toEqual(["yamada@a.jp", "b@b.jp"]);
  });

  it("an unregistered counterpart is shown as not counted; registering it makes it the company's contact", async () => {
    const leads = [lead(), lead({ id: "lead_2", companyName: "金沢クラウド合同会社", contactEmail: "info@kanazawa.example.jp" })];
    const registerContactEmail = vi.fn(async (leadId: string, body: sponsor.RegisterContactEmailRequest): Promise<sponsor.RegisterContactEmailResponse> => {
      const next = { ...leads[1]!, contactEmail: `info@kanazawa.example.jp／${body.address}`, status: "初回連絡" as const, firstContactOn: "2026-11-01", version: 2 };
      leads[1] = next;
      return { lead: next };
    });
    const api = { ...apiOver(demoFetch()), listLeads: async () => ({ leads }), list: async () => ({ cards: [] }), registerContactEmail } as SponsorApi;
    // 同じドメイン (kanazawa.example.jp) でも、登録していない ceo@ は数えない。
    renderWith(<SponsorMailLink addresses={["suzuki@developershub.jp", "ceo@kanazawa.example.jp"]} threadId="thr_9" />, api, WRITER);
    expect((await screen.findByTestId("fe2-sponsor-mail-link-how")).textContent).toContain("未登録のアドレス");
    expect(screen.queryByTestId("fe2-sponsor-mail-link-current")).toBeNull();

    fireEvent.click(screen.getByTestId("fe2-sponsor-mail-link-menu-trigger"));
    fireEvent.change(screen.getByTestId("fe2-sponsor-mail-link-menu-search"), { target: { value: "金沢" } });
    fireEvent.click(await screen.findByTestId("fe2-sponsor-mail-link-option-lead_2"));

    await waitFor(() => expect(registerContactEmail).toHaveBeenCalledWith("lead_2", { address: "ceo@kanazawa.example.jp" }));
    expect((await screen.findByTestId("fe2-sponsor-mail-link-current")).textContent).toBe("金沢クラウド合同会社");
    expect(screen.getByTestId("fe2-sponsor-mail-link-how").textContent).toBe("担当者メールに登録済み");
    expect(await screen.findByText("「金沢クラウド合同会社」の担当者メールに登録しました")).toBeTruthy();
  });

  it("recognizes an address registered on a business card of the same company", async () => {
    const api = { ...apiOver(demoFetch()), listLeads: async () => ({ leads: [lead()] }), list: async () => ({ cards: [card({ companyName: "（株）北陸テック" })] }) } as SponsorApi;
    renderWith(<SponsorMailLink addresses={["kawaguchi@hokuriku.example.jp"]} threadId="t" />, api, WRITER);
    expect((await screen.findByTestId("fe2-sponsor-mail-link-current")).textContent).toBe("株式会社北陸テック");
    expect(screen.getByTestId("fe2-sponsor-mail-link-how").textContent).toBe("名刺に登録済み");
  });

  it("shows nothing for viewers or internal-only threads", async () => {
    const api = { ...apiOver(demoFetch()), listLeads: async () => ({ leads: [lead({ contactEmail: "yamada@hokuriku.example.jp" })] }) } as SponsorApi;
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
    expect(screen.getByTestId("fe2-sponsor-backfill").textContent).toContain("名刺または担当者メールに登録したアドレスとのメールだけを数えます");
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
        const proposal = { leadId: `l${offset}`, companyName: `企業${offset}`, matchedBy: "contact" as const, changes: [], evidence: [] };
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

describe("demo: 登録したアドレスにメールを送ると営業進捗が進む", () => {
  const send = (fetchImpl: typeof fetch, to: string) =>
    fetchImpl("https://demo.local/api/v1/mail/outbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: [{ email: to }], subject: "協賛のご相談", textBody: "はじめまして" }),
    });

  it("an unregistered address on the company's domain changes nothing; the business-card address makes it 初回連絡 + today", async () => {
    const fetchImpl = demoFetch();
    const api = apiOver(fetchImpl);
    const before = await api.getLead("lead_demo_8");
    expect(before).toMatchObject({ status: "未接触", firstContactOn: null, contactEmail: null });

    expect((await send(fetchImpl, "info@wajima-media.example.jp")).ok).toBe(true);
    expect(await api.getLead("lead_demo_8")).toMatchObject({ status: "未接触", firstContactOn: null, version: before.version });

    expect((await send(fetchImpl, "tanaka@wajima-media.example.jp")).ok).toBe(true);
    const after = await api.getLead("lead_demo_8");
    const todayJst = sponsor.jstDate(new Date().toISOString());
    expect(after).toMatchObject({ status: "初回連絡", firstContactOn: todayJst, lastContactOn: todayJst, version: before.version + 1 });
    const { activity } = await api.listLeadActivity("lead_demo_8");
    expect(activity).toHaveLength(1);
    const d = describeActivity(activity[0]!);
    expect(d.title).toMatch(/^メールから自動更新: .* 送信$/);
    expect(d.route).toContain("tanaka@wajima-media.example.jp");
    expect(d.route).toContain("名刺に登録済み");
    expect(d.changes.join("、")).toContain("ステータス 未接触 → 初回連絡");
  });

  it("registering the ACME sender from the demo inbox as a contact fills that lead from past mail", async () => {
    const api = apiOver(demoFetch());
    const res = await api.registerContactEmail("lead_demo_9", { address: "sponsor@acme.co.jp" });
    expect(res.lead).toMatchObject({ contactEmail: "sponsor@acme.co.jp", status: "返信あり" });
    expect(res.lead.firstContactOn).not.toBeNull();
  });
});
