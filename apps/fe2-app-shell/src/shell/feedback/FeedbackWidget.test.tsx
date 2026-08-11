import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError } from "../../lib/api-client.tsx";
import { FeedbackWidget } from "./FeedbackWidget.tsx";

// Minimal ApiClient double: only `request` is exercised by the widget.
function apiWith(request: ApiClient["request"]): ApiClient {
  return { request } as unknown as ApiClient;
}

describe("FeedbackWidget", () => {
  beforeEach(() => {
    document.title = "テスト画面";
    window.history.pushState({}, "", "/events");
  });

  it("renders a labelled floating trigger and keeps the panel closed initially", () => {
    render(<FeedbackWidget api={apiWith(vi.fn())} />);
    const fab = screen.getByTestId("fe2-feedback-fab");
    expect(fab).toHaveAttribute("aria-label", "フィードバックを送る");
    expect(fab).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("fe2-feedback-panel")).not.toBeInTheDocument();
  });

  it("opens the panel and shows the current page as the submission source", async () => {
    render(<FeedbackWidget api={apiWith(vi.fn())} />);
    await userEvent.click(screen.getByTestId("fe2-feedback-fab"));
    expect(screen.getByTestId("fe2-feedback-panel")).toBeInTheDocument();
    const ctx = screen.getByTestId("fe2-feedback-context");
    expect(ctx).toHaveTextContent("テスト画面");
    expect(ctx).toHaveTextContent("/events");
  });

  it("blocks submit and shows a field error when the message is empty", async () => {
    const request = vi.fn();
    render(<FeedbackWidget api={apiWith(request)} />);
    await userEvent.click(screen.getByTestId("fe2-feedback-fab"));
    await userEvent.click(screen.getByTestId("fe2-feedback-submit"));
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByText("内容を入力してください。")).toBeInTheDocument();
  });

  it("POSTs message + category + auto page context and shows the thanks state", async () => {
    const request = vi.fn().mockResolvedValue({ id: "fb_1" });
    render(<FeedbackWidget api={apiWith(request)} />);
    await userEvent.click(screen.getByTestId("fe2-feedback-fab"));
    await userEvent.type(screen.getByTestId("fe2-feedback-message"), "並び順を直してほしい");
    await userEvent.selectOptions(screen.getByTestId("fe2-feedback-category"), "bug");
    await userEvent.click(screen.getByTestId("fe2-feedback-submit"));

    await waitFor(() => expect(screen.getByTestId("fe2-feedback-success")).toBeInTheDocument());
    expect(request).toHaveBeenCalledTimes(1);
    const arg = request.mock.calls[0]![0];
    expect(arg).toMatchObject({ method: "POST", path: "/api/v1/feedback" });
    expect(arg.body).toMatchObject({
      message: "並び順を直してほしい",
      category: "bug",
      pagePath: "/events",
      screenName: "テスト画面",
    });
    expect(typeof arg.body.pageUrl).toBe("string");
  });

  it("surfaces a localized error and keeps the form when the POST fails", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new ApiError(500, { error: { code: "INTERNAL", message: "boom", retryable: true } }));
    render(<FeedbackWidget api={apiWith(request)} />);
    await userEvent.click(screen.getByTestId("fe2-feedback-fab"));
    await userEvent.type(screen.getByTestId("fe2-feedback-message"), "エラーの再現");
    await userEvent.click(screen.getByTestId("fe2-feedback-submit"));

    const err = await screen.findByTestId("fe2-feedback-error");
    expect(err).toHaveTextContent("サーバーでエラーが発生しました。");
    // Form is still present so the user can retry.
    expect(screen.getByTestId("fe2-feedback-form")).toBeInTheDocument();
  });

  it("closes on Escape (Modal focus/keyboard handling)", async () => {
    render(<FeedbackWidget api={apiWith(vi.fn())} />);
    await userEvent.click(screen.getByTestId("fe2-feedback-fab"));
    expect(screen.getByTestId("fe2-feedback-panel")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("fe2-feedback-panel")).not.toBeInTheDocument());
  });
});
