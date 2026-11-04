// 「Googleと連携」の戻り (/driveshare?code&state=lnk_…) をシェルが完了させる。他の URL では何もしない。
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/api-client.tsx";
import { GoogleLinkReturn } from "./GoogleLinkReturn.tsx";

function renderAt(url: string, api: ApiClient, onDone = vi.fn()) {
  window.history.replaceState(null, "", url);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <GoogleLinkReturn api={api} onDone={onDone} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return onDone;
}

describe("GoogleLinkReturn", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("finishes a link return, clears the address and goes back", async () => {
    const request = vi.fn(async () => ({ googleLinked: true }));
    const onDone = renderAt("/driveshare?code=c1&state=lnk_one", { request } as unknown as ApiClient);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith({ method: "POST", path: "/api/v1/meetings/me/google-link/callback", body: { code: "c1", state: "lnk_one" } });
    expect(window.location.search).toBe("");
    expect(await screen.findByText(/Google と連携しました/)).toBeTruthy();
  });

  it("ignores the account-connect return and plain URLs (no toast provider needed)", () => {
    const request = vi.fn();
    window.history.replaceState(null, "", "/driveshare?code=c&state=plain");
    render(<GoogleLinkReturn api={{ request } as unknown as ApiClient} onDone={vi.fn()} />);
    expect(request).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?code=c&state=plain");
  });
});
