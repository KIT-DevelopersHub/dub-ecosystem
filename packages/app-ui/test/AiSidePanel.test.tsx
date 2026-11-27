import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AiSidePanel } from "../src/components/AiSidePanel";
import { AI_CHAT_AVAILABLE, AI_RELEASE_DATE_LABEL, AI_UNAVAILABLE_MESSAGE } from "../src/ai/aiRelease";

describe("AiSidePanel", () => {
  it("while the AI is off: the input and send are disabled and the 公開予定 notice shows", () => {
    render(
      <AiSidePanel onClose={vi.fn()} context={null} chatAvailable={false} unavailableMessage={AI_UNAVAILABLE_MESSAGE} testId="p" />,
    );
    expect(AI_CHAT_AVAILABLE).toBe(false);
    expect(AI_RELEASE_DATE_LABEL).toBe("12/3");
    expect(screen.getByTestId("p-unavailable")).toHaveTextContent("現在は利用できません。12/3 公開予定です。");
    expect(screen.getByTestId("p-input")).toBeDisabled();
    expect(screen.getByTestId("p-send")).toBeDisabled();
  });

  it("shows the context (label + title), or a skeleton while it loads", () => {
    const { rerender } = render(
      <AiSidePanel onClose={vi.fn()} context={{ label: "イベント", title: "北陸ITカンファレンス" }} chatAvailable={false} unavailableMessage="x" testId="p" />,
    );
    expect(screen.getByTestId("p-context")).toHaveTextContent("イベント");
    expect(screen.getByTestId("p-context")).toHaveTextContent("北陸ITカンファレンス");
    rerender(
      <AiSidePanel onClose={vi.fn()} context={{ label: "イベント", title: null, loading: true }} chatAvailable={false} unavailableMessage="x" testId="p" />,
    );
    expect(screen.getByTestId("p-context-skeleton")).toBeInTheDocument();
  });

  it("closes from the × button and from Escape", () => {
    const onClose = vi.fn();
    render(<AiSidePanel onClose={onClose} context={null} chatAvailable={false} unavailableMessage="x" testId="p" />);
    fireEvent.click(screen.getByTestId("p-close"));
    fireEvent.keyDown(screen.getByTestId("p"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("when available, sends the trimmed question through the injected sender and clears the input", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<AiSidePanel onClose={vi.fn()} context={null} chatAvailable unavailableMessage="x" onSend={onSend} testId="p" />);
    expect(screen.queryByTestId("p-unavailable")).toBeNull();
    fireEvent.change(screen.getByTestId("p-input"), { target: { value: "  会場は？ " } });
    fireEvent.click(screen.getByTestId("p-send"));
    expect(onSend).toHaveBeenCalledWith("会場は？");
    await waitFor(() => expect(screen.getByTestId("p-input")).toHaveValue(""));
  });

  it("becomes a full-screen sheet on phone widths", () => {
    const css = readFileSync(resolve(__dirname, "../src/components/AiSidePanel.module.css"), "utf8");
    const narrow = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(narrow).toMatch(/position:\s*fixed/);
    expect(narrow).toMatch(/inset:\s*0/);
    expect(narrow).toMatch(/width:\s*100%/);
  });
});
