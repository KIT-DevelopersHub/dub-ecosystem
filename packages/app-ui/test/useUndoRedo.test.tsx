import { describe, it, expect, vi } from "vitest";
import { act, renderHook, render, fireEvent } from "@testing-library/react";
import { useEffect } from "react";
import { useUndoRedo, useUndoRedoHotkeys, type UndoRedo } from "../src/hooks/useUndoRedo";

describe("useUndoRedo — command stack", () => {
  it("push records an action and enables undo (redo stays disabled)", () => {
    const { result } = renderHook(() => useUndoRedo());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    act(() => result.current.push({ label: "move", undo: () => {}, redo: () => {} }));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.undoLabel).toBe("move");
  });

  it("peekUndo exposes the next command (with its confirm descriptor) without running it", async () => {
    const log: string[] = [];
    const { result } = renderHook(() => useUndoRedo());
    expect(result.current.peekUndo()).toBeUndefined(); // boundary
    act(() =>
      result.current.push({
        label: "削除",
        confirm: { message: "戻しますか？", confirmLabel: "戻す" },
        undo: () => { log.push("undo"); },
        redo: () => { log.push("redo"); },
      }),
    );
    // peek must NOT run the inverse — it only reveals what the next undo would reverse.
    expect(log).toEqual([]);
    expect(result.current.peekUndo()?.label).toBe("削除");
    expect(result.current.peekUndo()?.confirm?.confirmLabel).toBe("戻す");
    expect(result.current.canUndo).toBe(true);
  });

  it("undo runs the inverse and moves the entry onto the redo stack", async () => {
    const log: string[] = [];
    const { result } = renderHook(() => useUndoRedo());
    act(() => result.current.push({ undo: () => { log.push("undo"); }, redo: () => { log.push("redo"); } }));
    let ok = false;
    await act(async () => { ok = await result.current.undo(); });
    expect(ok).toBe(true);
    expect(log).toEqual(["undo"]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it("redo re-applies and returns the entry to the undo stack", async () => {
    const log: string[] = [];
    const { result } = renderHook(() => useUndoRedo());
    act(() => result.current.push({ undo: () => { log.push("undo"); }, redo: () => { log.push("redo"); } }));
    await act(async () => { await result.current.undo(); });
    let ok = false;
    await act(async () => { ok = await result.current.redo(); });
    expect(ok).toBe(true);
    expect(log).toEqual(["undo", "redo"]);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("undo on empty history is a harmless no-op (boundary)", async () => {
    const { result } = renderHook(() => useUndoRedo());
    let ok = true;
    await act(async () => { ok = await result.current.undo(); });
    expect(ok).toBe(false);
    expect(result.current.canUndo).toBe(false);
  });

  it("a fresh push clears the redo branch", async () => {
    const { result } = renderHook(() => useUndoRedo());
    act(() => result.current.push({ undo: () => {}, redo: () => {} }));
    await act(async () => { await result.current.undo(); });
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.push({ undo: () => {}, redo: () => {} }));
    expect(result.current.canRedo).toBe(false); // redo invalidated by the new action
  });

  it("honours the history limit (oldest dropped)", async () => {
    const order: number[] = [];
    const { result } = renderHook(() => useUndoRedo({ limit: 2 }));
    act(() => {
      for (let i = 0; i < 3; i++) result.current.push({ undo: () => { order.push(i); }, redo: () => {} });
    });
    // only the last 2 survive; undo them newest-first
    await act(async () => { await result.current.undo(); });
    await act(async () => { await result.current.undo(); });
    await act(async () => { await result.current.undo(); }); // empty now
    expect(order).toEqual([2, 1]); // entry 0 was dropped by the cap
  });

  it("clear empties both stacks", async () => {
    const { result } = renderHook(() => useUndoRedo());
    act(() => result.current.push({ undo: () => {}, redo: () => {} }));
    act(() => result.current.clear());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});

// tiny harness component that wires the hotkeys to a controller
function Harness({ onReady }: { onReady: (h: UndoRedo) => void }) {
  const hist = useUndoRedo();
  useUndoRedoHotkeys(hist);
  useEffect(() => onReady(hist), [hist, onReady]);
  return (
    <div>
      <input data-testid="field" />
    </div>
  );
}

describe("useUndoRedoHotkeys", () => {
  it("Ctrl/Cmd-Z triggers undo, Ctrl-Shift-Z triggers redo", async () => {
    let hist: UndoRedo | null = null;
    render(<Harness onReady={(h) => { hist = h; }} />);
    const undo = vi.fn();
    const redo = vi.fn();
    act(() => hist!.push({ undo, redo }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await act(async () => {});
    expect(undo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await act(async () => {});
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("does NOT hijack Ctrl-Z while a text field is focused (native text undo)", async () => {
    let hist: UndoRedo | null = null;
    const { getByTestId } = render(<Harness onReady={(h) => { hist = h; }} />);
    const undo = vi.fn();
    act(() => hist!.push({ undo, redo: () => {} }));
    const field = getByTestId("field") as HTMLInputElement;
    field.focus();
    fireEvent.keyDown(field, { key: "z", ctrlKey: true });
    await act(async () => {});
    expect(undo).not.toHaveBeenCalled();
  });

  it("Cmd-Z (mac) triggers undo, Shift-Cmd-Z triggers redo", async () => {
    let hist: UndoRedo | null = null;
    render(<Harness onReady={(h) => { hist = h; }} />);
    const undo = vi.fn();
    const redo = vi.fn();
    act(() => hist!.push({ undo, redo }));
    fireEvent.keyDown(window, { key: "z", metaKey: true }); // ⌘Z
    await act(async () => {});
    expect(undo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true }); // ⇧⌘Z
    await act(async () => {});
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("Ctrl-Y (windows/linux) triggers redo", async () => {
    let hist: UndoRedo | null = null;
    render(<Harness onReady={(h) => { hist = h; }} />);
    const undo = vi.fn();
    const redo = vi.fn();
    act(() => hist!.push({ undo, redo }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await act(async () => {});
    fireEvent.keyDown(window, { key: "y", ctrlKey: true }); // conventional Windows redo
    await act(async () => {});
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("does NOT hijack Ctrl-Z while an IME is composing (変換確定中)", async () => {
    let hist: UndoRedo | null = null;
    render(<Harness onReady={(h) => { hist = h; }} />);
    const undo = vi.fn();
    act(() => hist!.push({ undo, redo: () => {} }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, keyCode: 229 }); // legacy browsers
    await act(async () => {});
    expect(undo).not.toHaveBeenCalled();
  });

  it("Alt+Ctrl-Z is ignored (reserved modifier combo)", async () => {
    let hist: UndoRedo | null = null;
    render(<Harness onReady={(h) => { hist = h; }} />);
    const undo = vi.fn();
    act(() => hist!.push({ undo, redo: () => {} }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, altKey: true });
    await act(async () => {});
    expect(undo).not.toHaveBeenCalled();
  });
});
