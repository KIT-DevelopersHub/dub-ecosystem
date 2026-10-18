// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountMailDialog, ACCOUNT_MAIL_APP_URL, isDevhubAddress } from "../src/index";

describe("AccountMailDialog", () => {
  it("shows the recipient, cc and app url, and reports 送る / あとで", async () => {
    const onSend = vi.fn();
    const onClose = vi.fn();
    render(<AccountMailDialog open name="山田 太郎" to="taro@gmail.com" cc="taro@developershub.jp" onSend={onSend} onClose={onClose} />);
    expect(screen.getByText("アカウント発行メールを送りますか？")).toBeInTheDocument();
    expect(screen.getByTestId("account-mail-dialog-to")).toHaveTextContent("taro@gmail.com");
    expect(screen.getByTestId("account-mail-dialog-cc")).toHaveTextContent("taro@developershub.jp");
    expect(screen.getByTestId("account-mail-dialog-app-url")).toHaveTextContent(ACCOUNT_MAIL_APP_URL);
    await userEvent.click(screen.getByTestId("account-mail-dialog-send"));
    expect(onSend).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("account-mail-dialog-later"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an inline error and disables あとで while sending", () => {
    render(<AccountMailDialog open name="x" to="a@gmail.com" cc="a@developershub.jp" sending error="送れませんでした" onSend={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("送れませんでした");
    expect(screen.getByTestId("account-mail-dialog-later")).toBeDisabled();
  });

  it("isDevhubAddress accepts only @developershub.jp", () => {
    expect(isDevhubAddress(" Taro@DevelopersHub.jp ")).toBe(true);
    expect(isDevhubAddress("bot@slack-import.invalid")).toBe(false);
    expect(isDevhubAddress("taro@gmail.com")).toBe(false);
    expect(isDevhubAddress(null)).toBe(false);
  });
});
