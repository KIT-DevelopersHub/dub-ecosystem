import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShortcutsDialog } from "./ShortcutsDialog.tsx";
import { SHORTCUTS } from "./shortcuts/registry.ts";

describe("ShortcutsDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("lists every registered shortcut from the registry (single source of truth)", () => {
    render(<ShortcutsDialog open onOpenChange={() => {}} />);
    // Every registry entry renders a labelled row — no hardcoded second list.
    for (const s of SHORTCUTS) {
      expect(screen.getByTestId(`fe2-shortcuts-row-${s.id}`)).toBeInTheDocument();
      expect(screen.getByText(s.label)).toBeInTheDocument();
    }
  });

  it("shows the command-palette chord and its own '?' hotkey", () => {
    render(<ShortcutsDialog open onOpenChange={() => {}} />);
    // The palette row shows K plus the mod key (⌘ or Ctrl depending on the test env).
    const paletteRow = screen.getByTestId("fe2-shortcuts-row-command-palette");
    expect(paletteRow.textContent).toContain("K");
    // The help dialog lists itself.
    const helpRow = screen.getByTestId("fe2-shortcuts-row-shortcuts-help");
    expect(helpRow.textContent).toContain("?");
  });

  it("opens on the global '?' hotkey", async () => {
    const onOpenChange = vi.fn();
    render(<ShortcutsDialog open={false} onOpenChange={onOpenChange} />);
    await userEvent.keyboard("?");
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("does not open on '?' while typing in an input", async () => {
    const onOpenChange = vi.fn();
    render(
      <>
        <input data-testid="field" />
        <ShortcutsDialog open={false} onOpenChange={onOpenChange} />
      </>,
    );
    const field = screen.getByTestId("field");
    field.focus();
    await userEvent.keyboard("?");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes via the Modal's close affordance", async () => {
    const onOpenChange = vi.fn();
    render(<ShortcutsDialog open onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByLabelText("閉じる"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
