import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { task } from "@dub/types";
import { TaskStatusBadge } from "../src/components/TaskStatusBadge";

// TaskStatusBadge is a thin binding over the @dub/ui <Badge>: it must keep the
// Japanese label + `fe4-status-*` testId contract AND map each status to the
// correct design-system semantic tone (data-tone), so status colour comes from
// the shared design system rather than a local stylesheet.
const CASES: Array<[task.TaskStatus, string, string]> = [
  ["todo", "未着手", "neutral"],
  ["in_progress", "進行中", "info"],
  ["blocked", "ブロック", "warning"],
  ["done", "完了", "success"],
  ["cancelled", "中止", "neutral"],
];

describe("TaskStatusBadge (@dub/ui Badge binding)", () => {
  it.each(CASES)("status %s → label + design-system tone", (status, label, tone) => {
    render(<TaskStatusBadge status={status} />);
    const el = screen.getByTestId(`fe4-status-${status}`);
    expect(el).toHaveTextContent(label);
    // data-tone is emitted by the @dub/ui Badge — proves the design-system path.
    expect(el).toHaveAttribute("data-tone", tone);
  });

  it("honours an explicit testId override", () => {
    render(<TaskStatusBadge status="done" testId="custom-badge" />);
    expect(screen.getByTestId("custom-badge")).toHaveTextContent("完了");
  });
});
