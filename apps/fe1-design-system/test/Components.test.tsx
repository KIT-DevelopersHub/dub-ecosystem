import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Badge, Tag, Avatar } from "../src/components/Display";
import { Tabs } from "../src/components/Tabs";
import { EmptyState, ErrorState, SkeletonLoader } from "../src/components/States";
import { Tooltip, Popover } from "../src/components/Tooltip";
import { Card, Divider, PageHeader } from "../src/components/Layout";

describe("testId passthrough (e2e contract 凍結案 1-7)", () => {
  it("forwards testId to the DOM data-testid across components", () => {
    render(
      <>
        <Badge tone="brand" testId="badge">
          B
        </Badge>
        <Avatar name="Ada Lovelace" testId="avatar" />
        <Divider testId="divider" />
        <Card testId="card">c</Card>
      </>,
    );
    expect(screen.getByTestId("badge")).toBeInTheDocument();
    expect(screen.getByTestId("avatar")).toBeInTheDocument();
    expect(screen.getByTestId("divider")).toBeInTheDocument();
    expect(screen.getByTestId("card")).toBeInTheDocument();
  });
});

describe("Display", () => {
  it("Avatar shows initials from the name", () => {
    render(<Avatar name="Ada Lovelace" testId="a" />);
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("Avatar renders a fallback (no throw) for a null/undefined name", () => {
    // A shared leaf primitive must never crash the host app on bad input — a null name
    // once threw initials(null).trim() and took the whole chat screen down.
    render(<Avatar name={null as unknown as string} testId="a-null" />);
    expect(screen.getByTestId("a-null")).toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
  });

  it("Tag calls onRemove", async () => {
    const onRemove = vi.fn();
    render(
      <Tag onRemove={onRemove} testId="tag">
        react
      </Tag>,
    );
    await userEvent.click(screen.getByLabelText("削除"));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});

describe("Tabs", () => {
  it("marks the active tab and emits onChange", async () => {
    const onChange = vi.fn();
    render(
      <Tabs
        activeId="a"
        onChange={onChange}
        items={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ]}
        testId="tabs"
      />,
    );
    expect(screen.getByRole("tab", { name: "A" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("does not emit for a disabled tab", async () => {
    const onChange = vi.fn();
    render(
      <Tabs
        activeId="a"
        onChange={onChange}
        items={[
          { id: "a", label: "A" },
          { id: "b", label: "B", disabled: true },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "B" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("States", () => {
  it("EmptyState renders title and action", () => {
    render(<EmptyState title="何もありません" icon="search" action={<button>追加</button>} />);
    expect(screen.getByText("何もありません")).toBeInTheDocument();
    expect(screen.getByText("追加")).toBeInTheDocument();
  });

  it("ErrorState shows message, correlationId and retry", async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        error={{ code: "INTERNAL", message: "エラーが発生しました", correlationId: "req-123" }}
        onRetry={onRetry}
        testId="err"
      />,
    );
    expect(screen.getByTestId("err")).toHaveAttribute("data-error-code", "INTERNAL");
    expect(screen.getByText(/req-123/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("SkeletonLoader renders the requested number of lines", () => {
    render(<SkeletonLoader lines={4} testId="sk" />);
    expect(screen.getByTestId("sk").children).toHaveLength(4);
  });
});

describe("Tooltip / Popover", () => {
  it("Tooltip reveals content on hover", async () => {
    render(
      <Tooltip content="ヒント" testId="tip">
        <span>hover me</span>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.hover(screen.getByText("hover me"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("ヒント");
  });

  it("Popover toggles its panel and reflects aria-expanded", async () => {
    render(
      <Popover trigger={<span>open</span>}>
        <div>panel body</div>
      </Popover>,
    );
    const trigger = screen.getByRole("button");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog")).toHaveTextContent("panel body");
  });
});

describe("PageHeader", () => {
  it("renders title, description and actions", () => {
    render(<PageHeader title="タイトル" description="説明" actions={<button>新規</button>} />);
    expect(screen.getByRole("heading", { name: "タイトル" })).toBeInTheDocument();
    expect(screen.getByText("説明")).toBeInTheDocument();
    expect(screen.getByText("新規")).toBeInTheDocument();
  });
});
