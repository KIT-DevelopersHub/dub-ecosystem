// LP管理 → 旧プレビュー tests。プレビュー URL の組み立てと、/lp/preview → /lp?env=draft のリダイレクト。
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LpPreviewScreen } from "./LpPreviewScreen.tsx";
import { lpPreviewUrl } from "./lpPublish.ts";

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => nav.navigate }));

describe("lpPreviewUrl", () => {
  it("always pins the version number (never live) and carries tickets=on|off", () => {
    expect(lpPreviewUrl("v3.4", { tickets: "on", proposals: "on" }, "https://lp.example")).toBe(
      "https://lp.example/?version=3.4&tickets=on&proposals=on",
    );
    expect(lpPreviewUrl("v3.5", { tickets: "off", proposals: "off" }, "https://lp.example")).toBe(
      "https://lp.example/?version=3.5&tickets=off&proposals=off",
    );
  });

  it("adds the test-purchase token only with tickets=on", () => {
    expect(lpPreviewUrl("v3.4", { tickets: "on", proposals: "on", previewToken: "1.ab" }, "https://lp.example")).toBe(
      "https://lp.example/?version=3.4&tickets=on&proposals=on&tickets_preview=1.ab",
    );
    expect(lpPreviewUrl("v3.4", { tickets: "off", proposals: "on", previewToken: "1.ab" }, "https://lp.example")).toBe(
      "https://lp.example/?version=3.4&tickets=off&proposals=on",
    );
  });
});

describe("LpPreviewScreen (redirect)", () => {
  it("replaces /lp/preview with /lp?env=draft", () => {
    render(<LpPreviewScreen />);
    expect(screen.getByTestId("fe2-lp-preview-redirect")).toBeInTheDocument();
    expect(nav.navigate).toHaveBeenCalledWith({ to: "/lp", search: { env: "draft" }, replace: true });
  });
});
