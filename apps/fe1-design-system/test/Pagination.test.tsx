import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoadMore, Pagination } from "../src/components/Pagination";

describe("LoadMore", () => {
  it("renders nothing when hasMore is false", () => {
    const { container } = render(<LoadMore hasMore={false} onLoadMore={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows default label and fires onLoadMore", async () => {
    const onLoadMore = vi.fn();
    render(<LoadMore hasMore onLoadMore={onLoadMore} testId="lm" />);
    expect(screen.getByText("さらに読み込む")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("lm"));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("does not fire while loading (guards double-fire)", async () => {
    const onLoadMore = vi.fn();
    render(<LoadMore hasMore loading onLoadMore={onLoadMore} testId="lm" />);
    await userEvent.click(screen.getByTestId("lm"));
    expect(onLoadMore).not.toHaveBeenCalled();
  });
});

describe("Pagination", () => {
  it("disables prev on first page and next on last page", () => {
    render(<Pagination page={1} pageSize={10} totalCount={25} onPageChange={() => {}} />);
    expect(screen.getByLabelText("前のページ")).toBeDisabled();
    expect(screen.getByLabelText("次のページ")).not.toBeDisabled();
  });

  it("emits next page number", async () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} pageSize={10} totalCount={25} onPageChange={onPageChange} />);
    await userEvent.click(screen.getByLabelText("次のページ"));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});
