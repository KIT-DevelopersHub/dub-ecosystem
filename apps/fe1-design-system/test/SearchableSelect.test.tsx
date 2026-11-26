import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, within, act, renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchableSelect, buildSections } from "../src/components/SearchableSelect";
import { Modal } from "../src/components/Modal";
import { useRecentSelections } from "../src/utils/recent";
import type { SearchableSelectOption } from "../src/types";

const OPTIONS: SearchableSelectOption[] = [
  { value: "", label: "未割当" },
  { value: "user:kume", label: "久米", description: "kume@example.com", group: "メンバー" },
  { value: "user:araki", label: "荒木", group: "メンバー" },
  { value: "user:gone", label: "退会者", group: "メンバー", disabled: true },
  { value: "team:ops", label: "運営チーム", group: "チーム" },
];

function Harness(props: { pinned?: string[]; onChange?: (v: string) => void; loading?: boolean }) {
  const [v, setV] = useState<string>("");
  return (
    <>
      <label htmlFor="pick">担当</label>
      <SearchableSelect
        id="pick"
        value={v}
        onChange={(n) => {
          setV(n);
          props.onChange?.(n);
        }}
        options={OPTIONS}
        pinnedValues={props.pinned}
        pinnedLabel="最近選んだ人"
        loading={props.loading}
        testId="pick"
      />
    </>
  );
}

describe("SearchableSelect", () => {
  it("is labelled by its <label> and shows the selected label", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "担当" });
    expect(trigger).toHaveTextContent("未割当");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens with the search box focused, filters, and picks with the mouse", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByTestId("pick-trigger"));
    const search = screen.getByRole("combobox");
    expect(search).toHaveFocus();
    await userEvent.type(search, "kume@");
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["久米kume@example.com"]);
    await userEvent.click(screen.getByTestId("pick-option-user:kume"));
    expect(onChange).toHaveBeenCalledWith("user:kume");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("pick-trigger")).toHaveTextContent("久米");
    expect(screen.getByTestId("pick-trigger")).toHaveFocus();
  });

  it("groups options under headings", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("pick-trigger"));
    expect(screen.getByRole("group", { name: "メンバー" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "チーム" })).toBeInTheDocument();
  });

  it("keyboard: ArrowDown opens, arrows skip disabled options, Enter picks", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    screen.getByTestId("pick-trigger").focus();
    await userEvent.keyboard("{ArrowDown}");
    const search = screen.getByRole("combobox");
    // starts on the selected option (未割当)
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByTestId("pick-option-none").id);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}"); // 久米 → 荒木 → (skip 退会者) 運営チーム
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByTestId("pick-option-team:ops").id);
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("team:ops");
  });

  it("shows the empty state when nothing matches", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("pick-trigger"));
    await userEvent.type(screen.getByRole("combobox"), "zzz");
    expect(screen.getByTestId("pick-empty")).toHaveTextContent("見つかりません");
  });

  it("shows a skeleton while loading", async () => {
    render(<Harness loading />);
    await userEvent.click(screen.getByTestId("pick-trigger"));
    expect(screen.getByTestId("pick-loading")).toBeInTheDocument();
  });

  it("floats pinned (recent) values to the top while the query is empty", async () => {
    render(<Harness pinned={["user:araki", "user:gone", "user:missing"]} />);
    await userEvent.click(screen.getByTestId("pick-trigger"));
    const recent = screen.getByRole("group", { name: "最近選んだ人" });
    // disabled / unknown pinned values are not floated
    expect(within(recent).getAllByRole("option").map((o) => o.textContent)).toEqual(["荒木"]);
    // not duplicated below
    expect(within(screen.getByRole("group", { name: "メンバー" })).queryByText("荒木")).toBeNull();
  });

  it("Escape closes the menu but not the enclosing Modal", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="作成">
        <Harness />
      </Modal>,
    );
    await userEvent.click(screen.getByTestId("pick-trigger"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // clicking inside the portalled menu does not close the modal either
    await userEvent.click(screen.getByTestId("pick-trigger"));
    await userEvent.click(screen.getByTestId("pick-option-user:kume"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("pick-trigger")).toHaveTextContent("久米");
  });

  it("closes on an outside click", async () => {
    render(
      <div>
        <Harness />
        <p>outside</p>
      </div>,
    );
    await userEvent.click(screen.getByTestId("pick-trigger"));
    await userEvent.click(screen.getByText("outside"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("buildSections", () => {
  it("matches label and description, case/width-insensitively", () => {
    const s = buildSections(OPTIONS, "ＫＵＭＥ");
    expect(s.flatMap((x) => x.items.map((o) => o.value))).toEqual(["user:kume"]);
  });
});

describe("useRecentSelections", () => {
  beforeEach(() => localStorage.clear());

  it("keeps most-recent-first, dedupes, caps, and persists per key", () => {
    const { result } = renderHook(() => useRecentSelections("k1", 2));
    act(() => result.current.remember("a"));
    act(() => result.current.remember("b"));
    act(() => result.current.remember("a"));
    act(() => result.current.remember("c"));
    expect(result.current.recent).toEqual(["c", "a"]);
    expect(JSON.parse(localStorage.getItem("k1")!)).toEqual(["c", "a"]);
    const other = renderHook(() => useRecentSelections("k2"));
    expect(other.result.current.recent).toEqual([]);
  });

  it("survives a throwing storage", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useRecentSelections("k3"));
    act(() => result.current.remember("x"));
    expect(result.current.recent).toEqual(["x"]);
    spy.mockRestore();
  });
});
