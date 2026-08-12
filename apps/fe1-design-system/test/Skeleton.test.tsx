import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Skeleton,
  SkeletonList,
  SkeletonTable,
  SkeletonCard,
} from "../src/components/Skeleton";

describe("Skeleton", () => {
  it("is presentational (aria-hidden) and forwards testId", () => {
    render(<Skeleton testId="sk" />);
    const el = screen.getByTestId("sk");
    expect(el).toHaveAttribute("aria-hidden", "true");
  });

  it("applies numeric width/height as px", () => {
    render(<Skeleton width={80} height={16} testId="sk" />);
    const el = screen.getByTestId("sk");
    expect(el.style.width).toBe("80px");
    expect(el.style.height).toBe("16px");
  });

  it("circle variant mirrors width to height when height is omitted", () => {
    render(<Skeleton variant="circle" width={40} testId="sk" />);
    expect(screen.getByTestId("sk").style.height).toBe("40px");
  });
});

describe("SkeletonList", () => {
  it("announces loading once via role=status and renders the requested rows", () => {
    render(<SkeletonList rows={4} testId="list" />);
    const region = screen.getByTestId("list");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-label", "読み込み中");
    expect(region.children).toHaveLength(4);
  });

  it("adds a leading avatar block per row when avatar is set", () => {
    render(<SkeletonList rows={2} avatar testId="list" />);
    // each row = avatar circle + body wrapper (2 children)
    const firstRow = screen.getByTestId("list").children[0]!;
    expect(firstRow.children).toHaveLength(2); // circle + body
  });
});

describe("SkeletonTable", () => {
  it("renders header + rows and announces loading", () => {
    render(<SkeletonTable rows={3} columns={2} testId="tbl" />);
    const region = screen.getByTestId("tbl");
    expect(region).toHaveAttribute("role", "status");
    // header row + 3 body rows
    expect(region.children).toHaveLength(4);
  });

  it("omits the header row when header=false", () => {
    render(<SkeletonTable rows={3} columns={2} header={false} testId="tbl" />);
    expect(screen.getByTestId("tbl").children).toHaveLength(3);
  });
});

describe("SkeletonCard", () => {
  it("announces loading and renders a media block when requested", () => {
    render(<SkeletonCard media lines={2} testId="card" />);
    const region = screen.getByTestId("card");
    expect(region).toHaveAttribute("role", "status");
    // media + title + 2 lines
    expect(region.children).toHaveLength(4);
  });
});
