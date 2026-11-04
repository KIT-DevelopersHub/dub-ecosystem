// ダッシュボードの「定例に参加」: 自分の定例を並べる / 参加で出席を記録して Meet を開く (楽観的に
// 出席済み) / 定例が無い・取得できない人にはカードを出さない。openMeetWithAttendance の挙動も。
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { meeting } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../../lib/api-client.tsx";
import { openMeetWithAttendance, startGoogleLink } from "../../../lib/meet-join.ts";
import { RegularMeetingsCard, regularWhen } from "./RegularMeetingsCard.tsx";

const ITEMS: meeting.MyRegularMeeting[] = [
  {
    id: "mtg_all", title: "全体定例", targetName: "全体", kind: "all_hands", meetUrl: "https://meet.google.com/abc-defg-hij",
    next: { date: "2026-10-19", startsAt: "2026-10-19T12:00:00.000Z" }, durationMinutes: 60, joinOpen: true, attended: false,
  },
  {
    id: "mtg_dev", title: "開発定例", targetName: "開発", kind: "team", meetUrl: "https://meet.google.com/kln-opqr-stu",
    next: { date: "2026-10-21", startsAt: "2026-10-21T11:00:00.000Z" }, durationMinutes: 30, joinOpen: false, attended: false,
  },
];

function makeApi(handler: (req: { method: string; path: string }) => Promise<unknown>): ApiClient {
  return { request: vi.fn(handler) } as unknown as ApiClient;
}

function renderCard(api: ApiClient) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RegularMeetingsCard api={api} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("RegularMeetingsCard", () => {
  it("lists my 定例 with kind and time; 参加 records the join and opens the Meet", async () => {
    const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const api = makeApi(async ({ method, path }) => {
      if (method === "GET") return { items: ITEMS, googleLinked: true };
      expect(path).toBe("/api/v1/meetings/mtg_all/join");
      return { meetUrl: ITEMS[0]!.meetUrl, recordedFor: "2026-10-19" };
    });
    renderCard(api);
    expect((await screen.findByTestId("fe2-home-regular-mtg_all")).textContent).toContain("全体定例");
    expect(screen.getByTestId("fe2-home-regular-mtg_dev").textContent).toContain("チーム定例");
    fireEvent.click(screen.getByTestId("fe2-home-regular-mtg_all-join"));
    expect(await screen.findByTestId("fe2-home-regular-mtg_all-attended")).toBeTruthy(); // optimistic
    await waitFor(() => expect(tab.location.href).toBe("https://meet.google.com/abc-defg-hij"));
    expect(tab.opener).toBeNull();
    expect(screen.queryByTestId("fe2-home-regulars-link")).toBeNull(); // already linked
    open.mockRestore();
  });

  it("offers 「Googleと連携」 to a member who has not linked Google", async () => {
    renderCard(makeApi(async () => ({ items: ITEMS, googleLinked: false })));
    expect((await screen.findByTestId("fe2-home-regulars-link")).textContent).toContain("Meet に入るだけで出席になります");
  });

  it("renders nothing without 定例, or when the list cannot be read", async () => {
    const { container, unmount } = renderCard(makeApi(async () => ({ items: [], googleLinked: false })));
    await waitFor(() => expect(container.textContent).toBe(""));
    unmount();
    const failed = renderCard(makeApi(async () => Promise.reject(new Error("403"))));
    await waitFor(() => expect(failed.container.textContent).toBe(""));
  });

  it("formats the occurrence in JST", () => {
    expect(regularWhen({ date: "2026-10-19", startsAt: "2026-10-19T12:00:00.000Z" }, 60)).toBe("10/19(月) 21:00〜22:00");
  });
});

describe("startGoogleLink", () => {
  it("asks for the consent URL with /driveshare as the return page and goes there", async () => {
    const assign = vi.fn();
    const api = makeApi(async () => ({ authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }));
    await startGoogleLink(api, { origin: "https://app.example", assign });
    expect((api.request as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      method: "POST",
      path: "/api/v1/meetings/me/google-link/start",
      body: { redirectUri: "https://app.example/driveshare" },
    });
    expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1");
  });
});

describe("openMeetWithAttendance", () => {
  it("still opens the known link when the join fails", async () => {
    const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
    const win = { open: vi.fn(() => tab as unknown as Window) };
    let res: unknown = "pending";
    await act(async () => {
      res = await openMeetWithAttendance(() => Promise.reject(new Error("x")), "https://meet.google.com/a-b-c", win);
    });
    expect(res).toBeNull();
    expect(tab.location.href).toBe("https://meet.google.com/a-b-c");
  });

  it("closes the blank tab when there is no link at all", async () => {
    const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
    const win = { open: vi.fn(() => tab as unknown as Window) };
    await openMeetWithAttendance(async () => ({ meetUrl: null, recordedFor: null }), null, win);
    expect(tab.close).toHaveBeenCalled();
  });
});
