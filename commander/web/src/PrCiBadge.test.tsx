import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrCiBadge } from "./PrCiBadge.tsx";
import { Board } from "./Board.tsx";
import { makeFakePrApi, makePr } from "./lib/prFake.ts";
import { badgeOf, parsePrRef } from "./lib/prChecks.ts";
import { makeBoardItem, makeFakeApi, makeFakeClient } from "./test/fakes.ts";

const URL = "https://github.com/KIT-DevelopersHub/dub-ecosystem/pull/101";

describe("prChecks helpers", () => {
  it("parses a PR URL", () => {
    expect(parsePrRef(URL)).toEqual({ repo: "KIT-DevelopersHub/dub-ecosystem", number: 101 });
    expect(parsePrRef("https://example.com/x")).toBeNull();
    expect(parsePrRef(null)).toBeNull();
  });

  it("formats badge text per state", () => {
    const base = { passed: 3, total: 5, pending: 0, failing: ["a", "b"], requiredNotPassing: [] };
    expect(badgeOf({ ...base, state: "fail" })).toEqual({ tone: "danger", text: "✕ 3/5 · 2件失敗" });
    expect(badgeOf({ ...base, state: "pass", passed: 5 })).toEqual({ tone: "success", text: "✓ 5/5" });
    expect(badgeOf({ ...base, state: "pending" }).text).toBe("実行中 3/5");
    expect(badgeOf({ ...base, state: "none" }).text).toBe("CIなし");
  });
});

describe("PrCiBadge", () => {
  it("shows green pass count, labels, and expands to per-check links", async () => {
    const api = makeFakePrApi([makePr()]);
    render(<PrCiBadge prUrl={URL} api={api} />);
    const badge = await screen.findByTestId("pr-ci-101-badge");
    expect(badge).toHaveTextContent("CI ✓ 2/2");
    expect(screen.getByText("stagingへ")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("pr-ci-101-toggle"));
    const list = screen.getByTestId("pr-ci-101-list");
    expect(within(list).getByRole("link", { name: "ci / test" })).toHaveAttribute("href", "https://github.com/x/2");
    expect(within(list).getByText(/確認したラベル待ち/)).toBeInTheDocument();
  });

  it("red badge with failure count, 確認 disabled with the reason", async () => {
    const api = makeFakePrApi([
      makePr({
        checks: [
          { name: "a", state: "pass", url: null, required: true, labelGate: false },
          { name: "b", state: "fail", url: null, required: true, labelGate: false },
        ],
      }),
    ]);
    render(<PrCiBadge prUrl={URL} api={api} />);
    expect(await screen.findByTestId("pr-ci-101-badge")).toHaveTextContent("✕ 1/2 · 1件失敗");
    expect(screen.getByTestId("pr-ci-101-confirm")).toBeDisabled();
    expect(screen.getByTestId("pr-ci-101-reason")).toHaveTextContent("必須の CI が通過していません");
  });

  it("grey running badge", async () => {
    const api = makeFakePrApi([
      makePr({ checks: [{ name: "e2e", state: "pending", url: null, required: true, labelGate: false }] }),
    ]);
    render(<PrCiBadge prUrl={URL} api={api} />);
    expect(await screen.findByTestId("pr-ci-101-badge")).toHaveTextContent("実行中 0/1");
  });

  it("already labeled shows 確認済み and no button", async () => {
    const api = makeFakePrApi([makePr({ labels: ["確認した"] })]);
    render(<PrCiBadge prUrl={URL} api={api} />);
    expect(await screen.findByTestId("pr-ci-101-confirmed")).toHaveTextContent("確認済み");
    expect(screen.queryByTestId("pr-ci-101-confirm")).toBeNull();
  });

  it("confirm: dialog -> optimistic 確認済み -> server-confirmed, with the viewed head SHA", async () => {
    const api = makeFakePrApi([makePr()]);
    api.confirmDelayMs = 30;
    render(<PrCiBadge prUrl={URL} api={api} />);
    await userEvent.click(await screen.findByTestId("pr-ci-101-confirm"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("本番にデプロイされます");
    await userEvent.click(within(dialog).getByRole("button", { name: "確認したを付ける" }));
    // optimistic before the call resolves
    expect(screen.getByTestId("pr-ci-101-confirmed")).toBeInTheDocument();
    await waitFor(() => expect(api.confirmCalls).toHaveLength(1));
    expect(api.confirmCalls[0]).toEqual({
      ref: { repo: "KIT-DevelopersHub/dub-ecosystem", number: 101 },
      headSha: makePr().headSha,
    });
    await waitFor(() => expect(api.prs.get(101)?.confirmed).toBe(true));
    expect(screen.getByTestId("pr-ci-101-confirmed")).toBeInTheDocument();
  });

  it("cancel in the dialog does nothing", async () => {
    const api = makeFakePrApi([makePr()]);
    render(<PrCiBadge prUrl={URL} api={api} />);
    await userEvent.click(await screen.findByTestId("pr-ci-101-confirm"));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "キャンセル" }));
    expect(api.confirmCalls).toHaveLength(0);
    expect(screen.getByTestId("pr-ci-101-confirm")).toBeEnabled();
  });

  it("rolls back and explains when the service refuses", async () => {
    const api = makeFakePrApi([makePr()]);
    api.failNextConfirm = "head_moved";
    render(<PrCiBadge prUrl={URL} api={api} />);
    await userEvent.click(await screen.findByTestId("pr-ci-101-confirm"));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "確認したを付ける" }));
    expect(await screen.findByTestId("pr-ci-101-action-error")).toHaveTextContent("新しい commit");
    expect(screen.queryByTestId("pr-ci-101-confirmed")).toBeNull();
    expect(screen.getByTestId("pr-ci-101-confirm")).toBeInTheDocument();
  });

  it("refresh bypasses the cache", async () => {
    const api = makeFakePrApi([makePr()]);
    const spy = vi.spyOn(api, "getChecks");
    render(<PrCiBadge prUrl={URL} api={api} />);
    await userEvent.click(await screen.findByTestId("pr-ci-101-refresh"));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.anything(), { fresh: true }));
  });
});

describe("placement: detail only, never the board list", () => {
  function setup() {
    const prs = makeFakePrApi([makePr()]);
    const getChecks = vi.spyOn(prs, "getChecks");
    const api = Object.assign(
      makeFakeApi([
        makeBoardItem({ taskId: "t-pr", featureId: "f-pr", prUrl: URL, prUrls: [URL], runStatus: "succeeded", featurePhase: "staging_review" }),
        makeBoardItem({ taskId: "t-none", featureId: "f-none", prUrl: null, runStatus: "succeeded", featurePhase: "staging_review" }),
      ]),
      { prs },
    );
    render(<Board client={makeFakeClient()} api={api} pollMs={0} />);
    return { prs, getChecks };
  }

  it("the board shows no CI badge and never fetches checks", async () => {
    const { getChecks } = setup();
    await screen.findByTestId("task-card-t-pr");
    expect(screen.queryByTestId(/^pr-ci-/)).toBeNull();
    expect(getChecks).not.toHaveBeenCalled();
  });

  it("opening the task detail shows CI and 確認 -> 確認済み", async () => {
    const { prs, getChecks } = setup();
    await userEvent.click(await screen.findByTestId("task-card-t-pr"));
    const ci = await screen.findByTestId("drawer-ci");
    expect(await within(ci).findByTestId("pr-ci-101-badge")).toHaveTextContent("✓ 2/2");
    expect(getChecks).toHaveBeenCalledTimes(1);
    await userEvent.click(within(ci).getByTestId("pr-ci-101-confirm"));
    const dialog = await screen.findByRole("dialog", { name: "本番への承認（確認した）" });
    await userEvent.click(within(dialog).getByRole("button", { name: "確認したを付ける" }));
    expect(await within(ci).findByTestId("pr-ci-101-confirmed")).toBeInTheDocument();
    expect(prs.confirmCalls).toHaveLength(1);
  });

  it("Esc closes only the confirm dialog, not the drawer", async () => {
    setup();
    await userEvent.click(await screen.findByTestId("task-card-t-pr"));
    const ci = await screen.findByTestId("drawer-ci");
    await userEvent.click(await within(ci).findByTestId("pr-ci-101-confirm"));
    await screen.findByRole("dialog", { name: "本番への承認（確認した）" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "本番への承認（確認した）" })).toBeNull());
    expect(screen.getByTestId("task-drawer")).toBeInTheDocument();
  });

  it("a task without a PR has no CI section in its detail", async () => {
    setup();
    await userEvent.click(await screen.findByTestId("task-card-t-none"));
    await screen.findByTestId("drawer-prs");
    expect(screen.queryByTestId("drawer-ci")).toBeNull();
  });
});
