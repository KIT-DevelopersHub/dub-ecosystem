import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PermissionDeniedScreen } from "./PermissionDeniedScreen.tsx";
import { NotFoundScreen } from "./NotFoundScreen.tsx";

describe("PermissionDeniedScreen (403)", () => {
  it("renders a 403 permission-denied message, distinct from the 404 screen", () => {
    render(<PermissionDeniedScreen />);
    expect(screen.getByTestId("fe2-forbidden")).toBeInTheDocument();
    expect(screen.getByText("403")).toBeInTheDocument();
    expect(screen.getByText("この機能の権限がありません")).toBeInTheDocument();
    // must NOT masquerade as "page not found"
    expect(screen.queryByText("ページが見つかりませんでした")).not.toBeInTheDocument();
  });

  it("is a different component/testid than NotFoundScreen so guards can tell them apart", () => {
    const { unmount } = render(<PermissionDeniedScreen />);
    expect(screen.getByTestId("fe2-forbidden")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-notfound")).not.toBeInTheDocument();
    unmount();
    render(<NotFoundScreen />);
    expect(screen.getByTestId("fe2-notfound")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-forbidden")).not.toBeInTheDocument();
  });
});
