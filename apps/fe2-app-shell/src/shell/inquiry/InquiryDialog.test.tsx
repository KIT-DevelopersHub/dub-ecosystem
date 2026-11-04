import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError } from "../../lib/api-client.tsx";
import { InquiryDialog } from "./InquiryDialog.tsx";
import { composeInquiryMessage, firstMissingField, specOf } from "./inquiryKinds.ts";

// Minimal ApiClient double: only `request` is exercised by the dialog.
function apiWith(request: ApiClient["request"]): ApiClient {
  return { request } as unknown as ApiClient;
}

function Harness({ api }: { api: ApiClient }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="harness-open">{String(open)}</span>
      <InquiryDialog api={api} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

describe("InquiryDialog", () => {
  beforeEach(() => {
    document.title = "テスト画面";
    window.history.pushState({}, "", "/events");
  });

  it("offers the five 種別 with フィードバック preselected and the source page shown", () => {
    render(<Harness api={apiWith(vi.fn())} />);
    for (const k of ["feedback", "business_card", "invite_friend", "interview", "other"]) {
      expect(screen.getByTestId(`fe2-inquiry-kind-${k}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("fe2-inquiry-kind-feedback")).toBeChecked();
    expect(screen.getByTestId("fe2-inquiry-category")).toBeInTheDocument();
    const ctx = screen.getByTestId("fe2-inquiry-context");
    expect(ctx).toHaveTextContent("テスト画面");
    expect(ctx).toHaveTextContent("/events");
  });

  it("feedback: blocks an empty message, then POSTs kind + category + nested page", async () => {
    const request = vi.fn().mockResolvedValue({ id: "nfb_1" });
    render(<Harness api={apiWith(request)} />);
    await userEvent.click(screen.getByTestId("fe2-inquiry-submit"));
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByText("内容を入力してください。")).toBeInTheDocument();

    await userEvent.type(screen.getByTestId("fe2-inquiry-message"), "並び順を直してほしい");
    await userEvent.selectOptions(screen.getByTestId("fe2-inquiry-category"), "bug");
    await userEvent.click(screen.getByTestId("fe2-inquiry-submit"));

    await waitFor(() => expect(screen.getByTestId("fe2-inquiry-success")).toBeInTheDocument());
    const arg = request.mock.calls[0]![0];
    expect(arg).toMatchObject({ method: "POST", path: "/api/v1/feedback" });
    expect(arg.body).toMatchObject({ kind: "feedback", category: "bug", message: "並び順を直してほしい", page: { name: "テスト画面" } });
    expect(arg.body).not.toHaveProperty("pagePath");
  });

  it("名刺が切れた: asks for 希望枚数 and sends it folded into the message (category other)", async () => {
    const request = vi.fn().mockResolvedValue({ id: "nfb_2" });
    render(<Harness api={apiWith(request)} />);
    await userEvent.click(screen.getByTestId("fe2-inquiry-kind-business_card"));
    expect(screen.queryByTestId("fe2-inquiry-category")).toBeNull();
    await userEvent.click(screen.getByTestId("fe2-inquiry-submit"));
    expect(screen.getByText("希望枚数を入力してください。")).toBeInTheDocument();

    await userEvent.type(screen.getByTestId("fe2-inquiry-count"), "100");
    await userEvent.type(screen.getByTestId("fe2-inquiry-note"), "来週までに");
    await userEvent.click(screen.getByTestId("fe2-inquiry-submit"));

    await waitFor(() => expect(screen.getByTestId("fe2-inquiry-success")).toBeInTheDocument());
    expect(request.mock.calls[0]![0].body).toMatchObject({
      kind: "business_card",
      category: "other",
      message: "希望枚数: 100枚\n\n補足:\n来週までに",
    });
  });

  it("面談を希望する: requires 希望日時の候補", async () => {
    const request = vi.fn().mockResolvedValue({});
    render(<Harness api={apiWith(request)} />);
    await userEvent.click(screen.getByTestId("fe2-inquiry-kind-interview"));
    await userEvent.type(screen.getByTestId("fe2-inquiry-topic"), "今後について");
    await userEvent.click(screen.getByTestId("fe2-inquiry-submit"));
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByText("希望日時の候補を入力してください。")).toBeInTheDocument();
    await userEvent.type(screen.getByTestId("fe2-inquiry-slots"), "11/10 午後");
    await userEvent.click(screen.getByTestId("fe2-inquiry-submit"));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0].body).toMatchObject({
      kind: "interview",
      message: "希望日時の候補:\n11/10 午後\n\n相談したい内容:\n今後について",
    });
  });

  it("surfaces a localized error and keeps the form when the POST fails", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new ApiError(500, { error: { code: "INTERNAL", message: "boom", retryable: true } }));
    render(<Harness api={apiWith(request)} />);
    await userEvent.type(screen.getByTestId("fe2-inquiry-message"), "エラーの再現");
    await userEvent.click(screen.getByTestId("fe2-inquiry-submit"));
    const err = await screen.findByTestId("fe2-inquiry-error");
    expect(err).toHaveTextContent("サーバーでエラーが発生しました。");
    expect(screen.getByTestId("fe2-inquiry-form")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<Harness api={apiWith(vi.fn())} />);
    expect(screen.getByTestId("fe2-inquiry-dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("fe2-inquiry-dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("harness-open")).toHaveTextContent("false");
  });
});

describe("inquiryKinds", () => {
  it("友達を誘いたい: omits blank optional fields and rejects a missing name", () => {
    const spec = specOf("invite_friend");
    expect(firstMissingField(spec, { contact: "x@example.com" })).toEqual({ key: "name", error: "友達の名前を入力してください。" });
    expect(composeInquiryMessage(spec, { name: "山田 太郎", contact: "", note: "" })).toBe("友達の名前: 山田 太郎");
    expect(composeInquiryMessage(spec, { name: "山田", contact: "@yamada" })).toBe("友達の名前: 山田\n連絡先: @yamada");
  });

  it("希望枚数 must be a positive integer", () => {
    const spec = specOf("business_card");
    expect(firstMissingField(spec, { count: "0" })?.key).toBe("count");
    expect(firstMissingField(spec, { count: "1.5" })?.key).toBe("count");
    expect(firstMissingField(spec, { count: "30" })).toBeNull();
  });

  it("その他 sends 内容 verbatim", () => {
    expect(composeInquiryMessage(specOf("other"), { message: "  よろしく  " })).toBe("よろしく");
  });
});
