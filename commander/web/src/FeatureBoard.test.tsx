import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureBoard } from "./FeatureBoard.tsx";
import type {
  ApiError,
  CommanderApi,
  Feature,
  FeatureDetail,
  FeaturePhase,
} from "./lib/commanderApi.ts";

function feature(over: Partial<Feature> = {}): Feature {
  return {
    id: "feat_1",
    title: "使用量ダッシュボード",
    phase: "demo_review",
    ledgerRef: null,
    createdAt: "t0",
    updatedAt: "t0",
    ...over,
  };
}

function detail(f: Feature, allowed: FeatureDetail["allowedTransitions"]): FeatureDetail {
  return { feature: f, allowedTransitions: allowed, transitions: [] };
}

interface FakeOpts {
  transitionError?: ApiError;
}

function fakeApi(f: Feature, allowed: FeatureDetail["allowedTransitions"], opts: FakeOpts = {}) {
  const transition = vi.fn(async (_id: string, to: FeaturePhase) => {
    if (opts.transitionError) return { ok: false as const, error: opts.transitionError };
    return {
      ok: true as const,
      value: {
        feature: { ...f, phase: to },
        transition: {
          id: "ptx_1",
          featureId: f.id,
          fromPhase: f.phase,
          toPhase: to,
          approvedByUser: false,
          actor: "system" as const,
          note: null,
          createdAt: "t1",
        },
      },
    };
  });
  const api: CommanderApi = {
    listFeatures: vi.fn(async () => [f]),
    createFeature: vi.fn(async () => ({ ok: true as const, value: f })),
    getFeature: vi.fn(async () => detail(f, allowed)),
    transition,
  };
  return { api, transition };
}

describe("<FeatureBoard>", () => {
  it("lists features and opens detail with the current phase", async () => {
    const { api } = fakeApi(feature(), [
      { to: "staging_deployed", requiresApproval: true, label: "demo承認→staging反映" },
      { to: "demo_rejected", requiresApproval: false, label: "demo却下(要修正)" },
    ]);
    render(<FeatureBoard api={api} />);

    const list = within(await screen.findByTestId("feature-list"));
    await waitFor(() => expect(list.getByText("使用量ダッシュボード")).toBeInTheDocument());
    await userEvent.click(list.getByText("使用量ダッシュボード"));

    const detailEl = await screen.findByTestId("feature-detail");
    expect(within(detailEl).getAllByTestId("phase-badge")[0]).toHaveTextContent("demo確認待ち");
    expect(screen.getByTestId("transition-staging_deployed")).toBeInTheDocument();
    // approval-required edge is visibly marked
    expect(screen.getByTestId("approval-flag-staging_deployed")).toBeInTheDocument();
  });

  it("performs a non-approval transition immediately (approvedByUser=false)", async () => {
    const { api, transition } = fakeApi(feature(), [
      { to: "demo_rejected", requiresApproval: false, label: "demo却下(要修正)" },
    ]);
    render(<FeatureBoard api={api} />);
    await userEvent.click(
      within(await screen.findByTestId("feature-list")).getByText("使用量ダッシュボード"),
    );
    await userEvent.click(await screen.findByTestId("transition-demo_rejected"));

    expect(transition).toHaveBeenCalledWith("feat_1", "demo_rejected", {
      approvedByUser: false,
    });
  });

  it("requires an explicit approval step for an approval-required edge", async () => {
    const { api, transition } = fakeApi(feature(), [
      { to: "staging_deployed", requiresApproval: true, label: "demo承認→staging反映" },
    ]);
    render(<FeatureBoard api={api} />);
    await userEvent.click(
      within(await screen.findByTestId("feature-list")).getByText("使用量ダッシュボード"),
    );

    // clicking the approval edge does NOT transition yet — it asks for confirmation
    await userEvent.click(await screen.findByTestId("transition-staging_deployed"));
    expect(transition).not.toHaveBeenCalled();
    expect(await screen.findByTestId("approval-confirm")).toBeInTheDocument();

    // confirming sends approvedByUser=true
    await userEvent.click(screen.getByTestId("approve-and-run"));
    expect(transition).toHaveBeenCalledWith("feat_1", "staging_deployed", {
      approvedByUser: true,
    });
  });

  it("shows the 段飛ばし (409) error from the server", async () => {
    const { api } = fakeApi(
      feature(),
      [{ to: "demo_rejected", requiresApproval: false, label: "demo却下(要修正)" }],
      { transitionError: { status: 409, error: "illegal_transition" } },
    );
    render(<FeatureBoard api={api} />);
    await userEvent.click(
      within(await screen.findByTestId("feature-list")).getByText("使用量ダッシュボード"),
    );
    await userEvent.click(await screen.findByTestId("transition-demo_rejected"));

    const banner = await screen.findByTestId("error-banner");
    expect(banner).toHaveTextContent("段飛ばし禁止");
    expect(banner).toHaveTextContent("409");
  });

  it("shows the 自己承認 (403) error from the server", async () => {
    const { api } = fakeApi(
      feature(),
      [{ to: "staging_deployed", requiresApproval: true, label: "demo承認→staging反映" }],
      { transitionError: { status: 403, error: "approval_required" } },
    );
    render(<FeatureBoard api={api} />);
    await userEvent.click(
      within(await screen.findByTestId("feature-list")).getByText("使用量ダッシュボード"),
    );
    await userEvent.click(await screen.findByTestId("transition-staging_deployed"));
    await userEvent.click(await screen.findByTestId("approve-and-run"));

    const banner = await screen.findByTestId("error-banner");
    expect(banner).toHaveTextContent("自己承認禁止");
    expect(banner).toHaveTextContent("403");
  });
});
