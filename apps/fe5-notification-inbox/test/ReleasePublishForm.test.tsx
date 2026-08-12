import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReleasePublishForm } from "../src/components/ReleasePublishForm";
import { makeDeps, renderWithDeps } from "./helpers";

describe("ReleasePublishForm", () => {
  it("publishes a release note and clears the form + toasts success", async () => {
    const { deps, harness } = makeDeps();
    renderWithDeps(<ReleasePublishForm />, deps);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/機能名/), "🎉 ガントチャートを追加");
    await user.type(screen.getByLabelText(/説明/), "タイムラインで一覧できます");
    await user.click(screen.getByRole("button", { name: /全員に配信/ }));

    await waitFor(() => {
      expect(harness.store.items.items[0]!.type).toBe("release");
    });
    expect(harness.store.items.items[0]!.title).toBe("🎉 ガントチャートを追加");
    expect(harness.toast.show).toHaveBeenCalledWith("success", expect.stringContaining("配信"));
    // Form cleared after publish.
    expect((screen.getByLabelText(/機能名/) as HTMLInputElement).value).toBe("");
  });

  it("keeps the submit button disabled until title + body are filled", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<ReleasePublishForm />, deps);
    const user = userEvent.setup();
    const btn = screen.getByRole("button", { name: /全員に配信/ });
    expect(btn).toBeDisabled();
    await user.type(screen.getByLabelText(/機能名/), "タイトルのみ");
    expect(btn).toBeDisabled();
    await user.type(screen.getByLabelText(/説明/), "本文");
    expect(btn).toBeEnabled();
  });
});
