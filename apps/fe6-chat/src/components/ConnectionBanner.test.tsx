import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionBanner } from "./ConnectionBanner";

describe("ConnectionBanner", () => {
  it("renders nothing when open", () => {
    const { container } = render(<ConnectionBanner status="open" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a reconnecting notice", () => {
    render(<ConnectionBanner status="reconnecting" />);
    expect(screen.getByTestId("fe6-channel-connection-banner")).toBeInTheDocument();
  });

  it("shows the archived banner regardless of status", () => {
    render(<ConnectionBanner status="open" archived />);
    expect(screen.getByTestId("fe6-channel-archived-banner")).toBeInTheDocument();
  });
});
