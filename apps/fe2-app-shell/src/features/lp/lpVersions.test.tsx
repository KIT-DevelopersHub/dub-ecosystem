// LP管理 → バージョン一覧 tests.
// 説明文は畳んで 1 行表示し、「詳細」を押した版だけ説明と PR リンクを出す。
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { LpManagementScreen } from "./LpManagementScreen.tsx";
import { LP_VERSIONS } from "./lpVersions.ts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LpManagementScreen />
    </QueryClientProvider>,
  );
}

describe("LpManagementScreen version list", () => {
  it("lists every version on one line with descriptions collapsed", async () => {
    renderScreen();
    await screen.findByTestId("fe2-lp-list");
    for (const v of LP_VERSIONS) {
      expect(screen.getByTestId(`fe2-lp-version-${v.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`fe2-lp-view-${v.id}`)).toBeInTheDocument();
      expect(screen.queryByText(v.description)).not.toBeInTheDocument();
    }
  });

  it("expands one version's description and PR link on 詳細", async () => {
    renderScreen();
    const current = LP_VERSIONS.find((v) => v.id === "v3.4")!;
    fireEvent.click(await screen.findByTestId("fe2-lp-details-toggle-v3.4"));
    expect(screen.getByTestId("fe2-lp-details-v3.4")).toHaveTextContent(current.description);
    expect(screen.getByRole("link", { name: "変更の PR を開く" })).toHaveAttribute("href", current.prUrl);
    expect(screen.queryByTestId("fe2-lp-details-v1.0")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("fe2-lp-details-toggle-v3.4"));
    expect(screen.queryByTestId("fe2-lp-details-v3.4")).not.toBeInTheDocument();
  });
});
