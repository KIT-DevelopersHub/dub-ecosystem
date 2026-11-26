// #855: load failures render an error + 再試行 (shared), distinct from empty states.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApiError } from "../lib/api-client.tsx";
import { describeLoadError, LoadErrorState } from "./LoadErrorState.tsx";
import { initialMailState, reducer } from "../features/mail/gmail/useMailStore.tsx";

const apiErr = (status: number, code = "X") => new ApiError(status, { error: { code, message: "m", retryable: false } });

describe("describeLoadError", () => {
  it("explains 429 / 5xx / network in Japanese", () => {
    expect(describeLoadError(apiErr(429), "メール").message).toBe(
      "メールを読み込めませんでした。アクセスが集中しています。少し待ってから再試行してください。",
    );
    expect(describeLoadError(apiErr(503)).message).toContain("サーバーで一時的な問題");
    expect(describeLoadError(apiErr(0, "NETWORK_ERROR")).message).toContain("ネットワーク");
    expect(describeLoadError(new Error("x")).message).toContain("データを読み込めませんでした");
  });
});

describe("LoadErrorState", () => {
  it("renders the message and a 再試行 button", () => {
    const onRetry = vi.fn();
    render(<LoadErrorState error={apiErr(429)} subject="通知" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("通知を読み込めませんでした");
    screen.getByRole("button", { name: "再試行" }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("mail list error vs empty (reducer)", () => {
  it("LIST_FAILED records the error; RETRY_LIST clears it and re-syncs; HYDRATE clears it", () => {
    const failed = reducer(initialMailState, { type: "LIST_FAILED", error: apiErr(429) });
    expect(failed.listLoading).toBe(false);
    expect(failed.listError).toBeInstanceOf(ApiError);
    const retried = reducer(failed, { type: "RETRY_LIST" });
    expect(retried.listError).toBeNull();
    expect(retried.listLoading).toBe(true);
    expect(retried.syncNonce).toBe(failed.syncNonce + 1);
    const hydrated = reducer(failed, { type: "HYDRATE", threads: [] });
    expect(hydrated.listError).toBeNull();
  });
});
