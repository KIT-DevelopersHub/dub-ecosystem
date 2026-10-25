import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, RequestInput } from "../../../lib/api-client.tsx";
import { CAMPFIRE_PROJECT_URL, CampfireCheerCard } from "./CampfireCheerCard.tsx";

function wrap(ui: ReactNode): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function makeApi(opts: { cheered?: boolean; postFails?: boolean } = {}) {
  const calls: RequestInput[] = [];
  let cheered = opts.cheered ?? false;
  const request = vi.fn(async (input: RequestInput) => {
    calls.push(input);
    if (input.path === "/api/v1/cheer/campfire/me") {
      return { cheeredByMe: cheered, myLastClickedAt: cheered ? "2026-10-25T01:00:00Z" : null, totalCheerers: cheered ? 4 : 3 };
    }
    if (input.path === "/api/v1/cheer/campfire/clicks") {
      if (opts.postFails) throw new Error("boom");
      cheered = true;
      return { ok: true, clickedAt: "2026-10-25T01:00:00Z" };
    }
    if (input.path === "/api/v1/admin/cheer/campfire/clicks") {
      return { items: [{ userId: "u1", displayName: "佐藤 太郎", email: "taro@x", firstClickedAt: "2026-10-24T00:00:00Z", lastClickedAt: "2026-10-24T00:00:00Z", clickCount: 1 }] };
    }
    throw new Error(`unexpected ${input.path}`);
  });
  return { api: { request } as unknown as ApiClient, calls };
}

describe("CampfireCheerCard", () => {
  it("opens CAMPFIRE in a new tab (no automation) and shows the first-time hint + 任意", async () => {
    const { api } = makeApi();
    render(wrap(<CampfireCheerCard api={api} />));
    const link = screen.getByTestId("fe2-campfire-cheer-open");
    expect(link.getAttribute("href")).toBe(CAMPFIRE_PROJECT_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("任意")).toBeTruthy();
    expect(await screen.findByTestId("fe2-campfire-cheer-firsttime")).toBeTruthy();
    expect(screen.getByTestId("fe2-campfire-cheer-firsttime").textContent).toContain("パスワードは自分で決めて");
  });

  it("records the click and flips to the thank-you state", async () => {
    const { api, calls } = makeApi();
    render(wrap(<CampfireCheerCard api={api} />));
    await screen.findByTestId("fe2-campfire-cheer-firsttime");
    fireEvent.click(screen.getByTestId("fe2-campfire-cheer-open"));
    expect(await screen.findByTestId("fe2-campfire-cheer-done")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/cheer/campfire/clicks")).toBe(true));
  });

  it("rolls back and tells the user when the record fails", async () => {
    const { api } = makeApi({ postFails: true });
    render(wrap(<CampfireCheerCard api={api} />));
    await screen.findByTestId("fe2-campfire-cheer-firsttime");
    fireEvent.click(screen.getByTestId("fe2-campfire-cheer-open"));
    expect(await screen.findByText(/押した記録を保存できませんでした/)).toBeTruthy();
    expect(await screen.findByTestId("fe2-campfire-cheer-firsttime")).toBeTruthy();
  });

  it("hides the cheerer list from members and shows it to admins", async () => {
    const member = makeApi();
    const { unmount } = render(wrap(<CampfireCheerCard api={member.api} />));
    expect(screen.queryByTestId("fe2-campfire-cheerers-open")).toBeNull();
    unmount();

    const admin = makeApi();
    render(wrap(<CampfireCheerCard api={admin.api} canViewCheerers />));
    expect(await screen.findByText("押した人 3 名")).toBeTruthy();
    fireEvent.click(screen.getByTestId("fe2-campfire-cheerers-open"));
    expect(await screen.findByText("佐藤 太郎")).toBeTruthy();
  });
});
