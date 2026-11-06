// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchableMenu, type SearchableMenuItem } from "../src";

const ITEMS: SearchableMenuItem[] = [
  { id: "a", label: "山田 花子", description: "hanako@x.jp", testId: "opt-a" },
  { id: "b", label: "田中 次郎", description: "jiro@x.jp", disabledReason: "選べません", testId: "opt-b" },
  { id: "c", label: "佐藤 太郎", description: "taro@x.jp", testId: "opt-c" },
];

function setup(props: Partial<Parameters<typeof SearchableMenu>[0]> = {}) {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  render(<SearchableMenu testId="sm" label="メンバー" trigger={<span>me@x.jp</span>} items={ITEMS} onSelect={onSelect} onOpenChange={onOpenChange} {...props} />);
  return { onSelect, onOpenChange };
}

describe("SearchableMenu", () => {
  it("opens with the search focused and reports open", async () => {
    const u = userEvent.setup();
    const { onOpenChange } = setup();
    await u.click(screen.getByTestId("sm-trigger"));
    expect(screen.getByTestId("sm-search")).toHaveFocus();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters by label and description (kana-insensitive substring)", async () => {
    const u = userEvent.setup();
    setup();
    await u.click(screen.getByTestId("sm-trigger"));
    await u.type(screen.getByTestId("sm-search"), "taro");
    expect(screen.getAllByRole("option").map((o) => o.dataset.testid)).toEqual(["opt-c"]);
  });

  it("disabled options show their reason and cannot be chosen", async () => {
    const u = userEvent.setup();
    const { onSelect } = setup();
    await u.click(screen.getByTestId("sm-trigger"));
    expect(screen.getByTestId("opt-b")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("opt-b")).toHaveTextContent("選べません");
    await u.click(screen.getByTestId("opt-b"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("arrow keys + Enter choose, and the panel closes", async () => {
    const u = userEvent.setup();
    const { onSelect } = setup();
    await u.click(screen.getByTestId("sm-trigger"));
    await u.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }));
    expect(screen.queryByTestId("sm-search")).not.toBeInTheDocument();
  });

  it("shows a skeleton while loading and an empty message when nothing matches", async () => {
    const u = userEvent.setup();
    setup({ loading: true });
    await u.click(screen.getByTestId("sm-trigger"));
    expect(screen.getByTestId("sm-loading")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("empty state", async () => {
    const u = userEvent.setup();
    setup();
    await u.click(screen.getByTestId("sm-trigger"));
    await u.type(screen.getByTestId("sm-search"), "zzz");
    expect(screen.getByTestId("sm-empty")).toBeInTheDocument();
  });
});
