// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./renderWithProviders";
import { createMockClient } from "../src/api/mockClient";
import { MailRateLimitBanner } from "../src/components/MailRateLimitBanner";
import type { MailRateLimitStatus } from "../src/lib/mailStatus";

describe("MailRateLimitBanner", () => {
  it("renders nothing while the mail API is not rate-limited", async () => {
    const { container } = renderWithProviders(<MailRateLimitBanner />);
    // Let the (clear) status query settle, then assert the banner never appears.
    await waitFor(() => expect(container).toBeTruthy());
    expect(screen.queryByTestId("fe7-mail-rate-limit-banner")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the メール送信API banner with a recovery hint when active", async () => {
    const active: MailRateLimitStatus = {
      active: true,
      code: "MAIL_RATE_LIMITED",
      since: new Date().toISOString(),
      recoversAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      cooldownSec: 1800,
    };
    const client = createMockClient({ mailRateLimit: active });
    renderWithProviders(<MailRateLimitBanner />, { client });

    const banner = await screen.findByTestId("fe7-mail-rate-limit-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent("メール送信API");
    expect(banner).toHaveTextContent("制限");
    expect(banner).toHaveTextContent("回復");
  });
});
