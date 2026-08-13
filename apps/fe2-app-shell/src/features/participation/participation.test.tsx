// 参加届 feature tests: the api adapter maps onto the shell ApiClient.request, and
// ParticipationPage drives the ParticipationApi (fill → submit → サンクス). All run
// against a faked ParticipationApi / ApiClient — no real network, green offline.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, RequestInput } from "../../lib/api-client.tsx";
import { createParticipationApi, type ParticipationApi } from "./participationApi.tsx";
import { ParticipationApiProvider } from "./ParticipationProvider.tsx";
import { ParticipationPage } from "./ParticipationPage.tsx";
import type { SubmitParticipationResponse } from "./contracts.ts";

function fakeApiClient(result: unknown = undefined): { api: ApiClient; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  const request = vi.fn(<TRes,>(input: RequestInput): Promise<TRes> => {
    calls.push(input);
    return Promise.resolve(result as TRes);
  });
  return { api: { request } as unknown as ApiClient, calls };
}

const CREATED: SubmitParticipationResponse = {
  matchKind: "created_new",
  member: {
    id: "m1", orgId: "o", name: "新規 太郎", roleTitle: null, status: "added",
    teamIds: [], contact: null, note: null, sortOrder: 1, version: 1, createdAt: "t", updatedAt: "t",
  },
  participation: {
    id: "p1", orgId: "o", memberId: "m1", name: "新規 太郎", nameKana: null, grade: null,
    department: null, contact: null, desiredTeamId: null, desiredActivity: null, note: null,
    status: "submitted", matchKind: "created_new", submittedBy: "u1", submittedAt: "t", createdAt: "t", updatedAt: "t",
  },
};

function makeApi(overrides: Partial<ParticipationApi> = {}): ParticipationApi {
  return {
    listTeams: () => Promise.resolve({ teams: [{ id: "t1", key: "venue", name: "会場", color: null, description: null }] }),
    submit: vi.fn(() => Promise.resolve(CREATED)),
    list: vi.fn(() => Promise.resolve({ participations: [] })),
    ...overrides,
  } as ParticipationApi;
}

function wrap(ui: ReactNode, api: ParticipationApi): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ParticipationApiProvider value={api}>{ui}</ParticipationApiProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe("createParticipationApi", () => {
  it("submit POSTs /api/v1/members/participation", async () => {
    const { api, calls } = fakeApiClient(CREATED);
    await createParticipationApi(api).submit({ name: "A" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/members/participation" });
  });

  it("listTeams GETs /api/v1/members/teams", async () => {
    const { api, calls } = fakeApiClient({ teams: [] });
    await createParticipationApi(api).listTeams();
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/members/teams" });
  });
});

describe("ParticipationPage", () => {
  it("blocks submit with an empty name", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("氏名を入力してください")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("submits the form and shows the サンクス outcome", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await userEvent.type(screen.getByTestId("participation-name"), "新規 太郎");
    await userEvent.click(screen.getByTestId("participation-submit"));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect((api.submit as any).mock.calls[0][0]).toMatchObject({ name: "新規 太郎" });
    expect(await screen.findByTestId("participation-thanks")).toBeInTheDocument();
    expect(screen.getByText(/新しく追加しました/)).toBeInTheDocument();
  });

  it("reports promotion (招待中→追加済) for a linked_existing match", async () => {
    const promoted: SubmitParticipationResponse = {
      ...CREATED,
      matchKind: "linked_existing",
      member: { ...CREATED.member, name: "既存 花子" },
    };
    const api = makeApi({ submit: vi.fn(() => Promise.resolve(promoted)) });
    render(wrap(<ParticipationPage />, api));
    await userEvent.type(screen.getByTestId("participation-name"), "既存 花子");
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(await screen.findByText(/招待中 → 追加済/)).toBeInTheDocument();
  });
});
