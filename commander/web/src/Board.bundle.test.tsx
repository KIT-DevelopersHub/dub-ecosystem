import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Board } from "./Board.tsx";
import type { BundleApi, StagingBundle } from "./lib/commanderApi.ts";
import { makeBoardItem, makeFakeApi, makeFakeClient } from "./test/fakes.ts";

const PR = (n: number) => `https://github.com/o/r/pull/${n}`;

function waiting(id: string, title: string, pr: number) {
  return makeBoardItem({ taskId: id, featureId: `f-${id}`, title, featurePhase: "staging_review", runStatus: "succeeded", prUrl: PR(pr) });
}

function makeBundleApi(): BundleApi & { _bundles: StagingBundle[] } {
  const api = {
    _bundles: [] as StagingBundle[],
    listBundles: vi.fn(async () => api._bundles.map((b) => ({ ...b }))),
    checkBundle: vi.fn(async () => []),
    createBundle: vi.fn(async (taskIds: string[]) => {
      const b: StagingBundle = { id: "b1", taskIds, status: "merging", slot: "staging2", stagingUrl: null, branch: "staging/b1", markers: {}, createdAt: "t" };
      api._bundles.push(b);
      return { ok: true as const, value: b };
    }),
    removeFromBundle: vi.fn(async (_id: string, taskId: string) => {
      for (const b of api._bundles) b.taskIds = b.taskIds.filter((x) => x !== taskId);
      return { ok: true as const, value: null };
    }),
    dissolveBundle: vi.fn(async () => {
      api._bundles = [];
      return { ok: true as const, value: null };
    }),
  };
  return api;
}

describe("<Board> staging 合体", () => {
  it("hides the merge UI when the backend has no bundle support", async () => {
    render(<Board client={makeFakeClient()} api={makeFakeApi([waiting("a", "A", 1), waiting("b", "B", 2)])} pollMs={0} />);
    await screen.findByText("A");
    expect(screen.queryByTestId("start-bundle")).not.toBeInTheDocument();
  });

  it("merges two waiting tasks into one bundle card and takes them out of their lane", async () => {
    const api = makeFakeApi([
      waiting("a", "通知の一括既読", 1),
      waiting("b", "メンバー検索", 2),
      makeBoardItem({ taskId: "d", featureId: "f-d", title: "demo確認中", featurePhase: "demo_review", runStatus: "succeeded", prUrl: PR(3) }),
    ]);
    const bundles = makeBundleApi();
    api.bundles = bundles;
    render(<Board client={makeFakeClient()} api={api} pollMs={0} />);

    await userEvent.click(await screen.findByTestId("start-bundle"));
    // demo 承認前のタスクは選べない
    expect(screen.getByTestId("bundle-pick-d")).toHaveAttribute("data-disabled", "true");
    await userEvent.click(screen.getByText("demo確認中"));
    expect(screen.getByTestId("bundle-pick-next")).toBeDisabled();

    await userEvent.click(screen.getByText("通知の一括既読"));
    await userEvent.click(screen.getByText("メンバー検索"));
    await userEvent.click(screen.getByTestId("bundle-pick-next"));
    const confirm = await screen.findByTestId("bundle-confirm");
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);

    expect(bundles.createBundle).toHaveBeenCalledWith(["a", "b"]);
    const lane = screen.getByTestId("lane-staging_deploying");
    const card = await within(lane).findByTestId("bundle-card-b1");
    expect(within(card).getByTestId("bundle-badge-b1")).toHaveTextContent("合体中 · 2 件");
    expect(within(screen.getByTestId("lane-staging_review")).queryByText("通知の一括既読")).not.toBeInTheDocument();
  });

  it("blocks the merge when the pre-check reports a blocking issue", async () => {
    const api = makeFakeApi([waiting("a", "A", 1), waiting("b", "B", 2)]);
    const bundles = makeBundleApi();
    bundles.checkBundle = vi.fn(async () => [{ taskIds: ["b"], message: "D1 マイグレーションを含む", block: true }]);
    api.bundles = bundles;
    render(<Board client={makeFakeClient()} api={api} pollMs={0} />);
    await userEvent.click(await screen.findByTestId("start-bundle"));
    await userEvent.click(screen.getByText("A"));
    await userEvent.click(screen.getByText("B"));
    await userEvent.click(screen.getByTestId("bundle-pick-next"));
    expect(await screen.findByText(/D1 マイグレーションを含む/)).toBeInTheDocument();
    expect(screen.getByTestId("bundle-confirm")).toBeDisabled();
  });

  it("opens a child's own drawer from the bundle and takes it out of the bundle on approval", async () => {
    const api = makeFakeApi([waiting("a", "A", 1), waiting("b", "B", 2)]);
    const bundles = makeBundleApi();
    bundles._bundles.push({ id: "b1", taskIds: ["a", "b"], status: "deployed", slot: "staging2", stagingUrl: "https://s2", branch: "x", markers: { a: "pass", b: "pass" }, createdAt: "t" });
    api.bundles = bundles;
    render(<Board client={makeFakeClient()} api={api} pollMs={0} />);

    await userEvent.click(await screen.findByTestId("bundle-child-a"));
    const drawer = await screen.findByTestId("task-drawer");
    expect(within(drawer).getByTestId("drawer-bundle-notice")).toHaveTextContent("一緒に: B");
    await userEvent.click(await within(drawer).findByTestId("action-approve"));
    const confirm = await within(drawer).findByTestId("approval-confirm-yes");
    await userEvent.click(confirm);
    await waitFor(() => expect(bundles.removeFromBundle).toHaveBeenCalledWith("b1", "a"));
  });
});
