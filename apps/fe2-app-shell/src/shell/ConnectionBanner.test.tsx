import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionBanner } from "./ConnectionBanner.tsx";

describe("ConnectionBanner", () => {
  it("is hidden (no message) when the connection is healthy", () => {
    render(<ConnectionBanner health="online" />);
    const el = screen.getByTestId("fe2-connection-banner");
    expect(el).toHaveAttribute("hidden");
    expect(el).toBeEmptyDOMElement();
    expect(el).toHaveAttribute("data-health", "online");
  });

  it("shows the offline copy when the network is down", () => {
    render(<ConnectionBanner health="offline" />);
    const el = screen.getByTestId("fe2-connection-banner");
    expect(el).not.toHaveAttribute("hidden");
    expect(el).toHaveAttribute("data-health", "offline");
    expect(el.textContent).toContain("インターネットに接続されていません");
  });

  it("shows the unreachable copy when the gateway can't be reached", () => {
    render(<ConnectionBanner health="unreachable" />);
    const el = screen.getByTestId("fe2-connection-banner");
    expect(el).not.toHaveAttribute("hidden");
    expect(el).toHaveAttribute("data-health", "unreachable");
    expect(el.textContent).toContain("サーバーに接続できません");
  });

  it("is a polite aria-live status region (non-invasive announcement)", () => {
    render(<ConnectionBanner health="unreachable" />);
    const el = screen.getByTestId("fe2-connection-banner");
    expect(el).toHaveAttribute("role", "status");
    expect(el).toHaveAttribute("aria-live", "polite");
  });
});
