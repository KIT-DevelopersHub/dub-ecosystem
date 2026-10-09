import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DoneList, matchesDone, prLabel } from "./DoneList.tsx";
import { makeBoardItem } from "./test/fakes.ts";

const PR = "https://github.com/KIT-DevelopersHub/dub-ecosystem/pull/573";
const items = [
  makeBoardItem({ taskId: "a", title: "policy 層の展開", taskStatus: "done", prUrl: PR, prUrls: [PR] }),
  makeBoardItem({ taskId: "b", title: "LP の文言修正", taskStatus: "done" }),
];

describe("<DoneList>", () => {
  it("1 行に タイトル と PR 番号を key-value で出す", () => {
    render(<DoneList items={items} onOpen={() => {}} />);
    const row = screen.getByTestId("task-card-a");
    expect(row).toHaveTextContent(/タイトル.*policy 層の展開.*PR.*#573/);
    expect(screen.getByTestId("done-pr-a")).toHaveAttribute("href", PR);
    expect(screen.getByTestId("task-card-b")).toHaveTextContent(/PR.*—/);
  });

  it("タイトル / PR 番号で絞り込める", async () => {
    render(<DoneList items={items} onOpen={() => {}} />);
    const box = screen.getByTestId("done-search");
    await userEvent.type(box, "#573");
    expect(screen.getByTestId("task-card-a")).toBeInTheDocument();
    expect(screen.queryByTestId("task-card-b")).not.toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, "zzz");
    expect(screen.getByTestId("done-no-match")).toBeInTheDocument();
  });

  it("行クリックでドロワーを開き、PR リンクのクリックでは開かない", async () => {
    const onOpen = vi.fn();
    render(<DoneList items={items} onOpen={onOpen} />);
    await userEvent.click(screen.getByTestId("done-pr-a"));
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("task-card-b"));
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("helpers", () => {
    expect(prLabel(PR)).toBe("#573");
    expect(matchesDone(items[0]!, "POLICY")).toBe(true);
    expect(matchesDone(items[1]!, "573")).toBe(false);
  });
});
