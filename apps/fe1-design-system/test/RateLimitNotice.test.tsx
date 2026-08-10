import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RateLimitNotice, formatRecoveryText } from "../src/components/RateLimitNotice";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");

describe("formatRecoveryText", () => {
  it("rounds up to minutes", () => {
    expect(formatRecoveryText(new Date(NOW + 90_000).toISOString(), NOW)).toBe("約2分後に回復する見込みです。");
  });
  it("rounds up to hours past 60 minutes", () => {
    expect(formatRecoveryText(new Date(NOW + 90 * 60_000).toISOString(), NOW)).toBe("約2時間後に回復する見込みです。");
  });
  it("reads 'まもなく' when the estimate is already past", () => {
    expect(formatRecoveryText(new Date(NOW - 1_000).toISOString(), NOW)).toBe("まもなく回復する見込みです。");
  });
  it("falls back to a quota-exhausted message with no ETA", () => {
    expect(formatRecoveryText(null, NOW)).toContain("送信上限に達しました");
    expect(formatRecoveryText(undefined, NOW)).toContain("送信上限に達しました");
  });
});

describe("RateLimitNotice", () => {
  it("renders nothing when not active", () => {
    const { container } = render(<RateLimitNotice serviceLabel="メール送信API" active={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces politely with the service label and recovery text when active", () => {
    render(
      <RateLimitNotice
        serviceLabel="メール送信API"
        active
        recoversAt={new Date(NOW + 5 * 60_000).toISOString()}
        now={NOW}
        testId="mail-rl"
      />,
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(banner).toHaveTextContent("メール送信APIが一時的に制限されています");
    expect(banner).toHaveTextContent("約5分後に回復する見込みです。");
    expect(screen.getByTestId("mail-rl")).toBeInTheDocument();
  });

  it("carries the tone through to the container", () => {
    render(<RateLimitNotice serviceLabel="X" active recoversAt={null} tone="danger" testId="rl" />);
    expect(screen.getByTestId("rl")).toHaveAttribute("data-tone", "danger");
  });
});
