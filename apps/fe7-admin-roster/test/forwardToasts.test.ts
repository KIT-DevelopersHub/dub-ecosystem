import { describe, it, expect, vi } from "vitest";
import { forwardToasts, useToastStore } from "../src/hooks/useToast";

describe("forwardToasts", () => {
  it("hands each toast to the shell once and stops after unsubscribing", () => {
    const show = vi.fn();
    const stop = forwardToasts(show);
    useToastStore.getState().show({ kind: "error", title: "削除に失敗しました", description: "理由" });
    useToastStore.getState().show({ kind: "success", title: "保存しました" });
    expect(show.mock.calls.map(([o]) => o)).toEqual([
      { kind: "error", title: "削除に失敗しました", description: "理由" },
      { kind: "success", title: "保存しました" },
    ]);
    expect(useToastStore.getState().toasts).toEqual([]);

    stop();
    useToastStore.getState().show({ kind: "info", title: "x" });
    expect(show).toHaveBeenCalledTimes(2);
  });
});
