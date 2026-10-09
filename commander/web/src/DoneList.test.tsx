import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DoneList } from "./DoneList.tsx";
import { matchesFilter, prLabel } from "./lib/filter.ts";
import { makeBoardItem } from "./test/fakes.ts";

const PR = "https://github.com/KIT-DevelopersHub/dub-ecosystem/pull/573";
const items = [
  makeBoardItem({ taskId: "a", title: "policy 層の展開", taskStatus: "done", prUrl: PR, prUrls: [PR] }),
  makeBoardItem({ taskId: "b", title: "LP の文言修正", taskStatus: "done" }),
];

describe("<DoneList>", () => {
  it("1 行に タイトル と PR 番号を出す", () => {
    render(<DoneList items={items} onOpen={() => {}} />);
    expect(screen.getByTestId("task-card-a")).toHaveTextContent(/policy 層の展開.*#573/);
    expect(screen.getByTestId("done-pr-a")).toHaveAttribute("href", PR);
    expect(screen.getByTestId("task-card-b")).toHaveTextContent(/PR なし/);
  });

  it("行クリックでドロワーを開き、PR リンクのクリックでは開かない", async () => {
    const onOpen = vi.fn();
    render(<DoneList items={items} onOpen={onOpen} />);
    await userEvent.click(screen.getByTestId("done-pr-a"));
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("task-card-b"));
    expect(onOpen).toHaveBeenCalledWith("b");
  });
});

describe("matchesFilter", () => {
  it("タイトル / PR 番号 / フォルダに部分一致し、空白区切りは AND", () => {
    // makeBoardItem の run cwd は "/repo/wt"
    const card = makeBoardItem({ taskId: "c", title: "ボード改善", runStatus: "running" });
    expect(prLabel(PR)).toBe("#573");
    expect(matchesFilter(items[0]!, "POLICY")).toBe(true);
    expect(matchesFilter(items[0]!, "#573")).toBe(true);
    expect(matchesFilter(items[1]!, "573")).toBe(false);
    expect(matchesFilter(card, "wt ボード")).toBe(true);
    expect(matchesFilter(card, "wt 無関係")).toBe(false);
    expect(matchesFilter(items[1]!, "  ")).toBe(true);
  });
});
