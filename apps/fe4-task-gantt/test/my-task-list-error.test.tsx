// #855: a failed task load shows an error + 再試行, not "タスクがありません".
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MyTaskList } from "../src/components/MyTaskList";

describe("MyTaskList load error", () => {
  it("renders the error state with 再試行 instead of the empty state", () => {
    const onRetry = vi.fn();
    render(
      <MyTaskList
        tasks={[]}
        users={new Map()}
        teamNames={new Map()}
        loadError={{ status: 429 }}
        onRetry={onRetry}
        onSelect={() => {}}
        visibleCount={20}
        onShowMore={() => {}}
      />,
    );
    expect(screen.getByTestId("fe4-mytasks-error")).toHaveTextContent("タスクを読み込めませんでした。アクセスが集中しています");
    expect(screen.queryByTestId("fe4-mytasks-empty")).toBeNull();
    screen.getByRole("button", { name: "再試行" }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("still shows the empty state when the load succeeded with 0 tasks", () => {
    render(
      <MyTaskList tasks={[]} users={new Map()} teamNames={new Map()} onSelect={() => {}} visibleCount={20} onShowMore={() => {}} />,
    );
    expect(screen.getByTestId("fe4-mytasks-empty")).toBeInTheDocument();
  });
});
