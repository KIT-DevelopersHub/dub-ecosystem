import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDraftAutosave, peekDraft } from "../src/hooks/useDraftAutosave";

// In-memory storage so tests never touch a real Storage and can assert writes.
function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

const KEY = "test.draft";

describe("useDraftAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does NOT persist while the form is empty/pristine (dirty=false)", () => {
    const store = memStorage();
    renderHook(() => useDraftAutosave({ storageKey: KEY, value: { body: "" }, dirty: false, storage: store }));
    act(() => vi.advanceTimersByTime(1000));
    expect(store._map.has(KEY)).toBe(false);
  });

  it("debounce-persists the value while dirty", () => {
    const store = memStorage();
    const { rerender } = renderHook(
      ({ v }: { v: string }) => useDraftAutosave({ storageKey: KEY, value: { body: v }, dirty: v !== "", storage: store, debounceMs: 300 }),
      { initialProps: { v: "" } },
    );
    rerender({ v: "wip" });
    expect(store._map.has(KEY)).toBe(false); // not yet — still debouncing
    act(() => vi.advanceTimersByTime(300));
    expect(JSON.parse(store._map.get(KEY)!)).toEqual({ body: "wip" });
  });

  it("removes the stored draft when the form goes back to clean", () => {
    const store = memStorage();
    store._map.set(KEY, JSON.stringify({ body: "old" }));
    const { rerender } = renderHook(
      ({ dirty }: { dirty: boolean }) => useDraftAutosave({ storageKey: KEY, value: { body: "" }, dirty, storage: store }),
      { initialProps: { dirty: true } },
    );
    rerender({ dirty: false });
    expect(store._map.has(KEY)).toBe(false);
  });

  it("restores a draft found at mount and exposes it once", () => {
    const store = memStorage();
    store._map.set(KEY, JSON.stringify({ body: "recovered" }));
    const { result } = renderHook(() =>
      useDraftAutosave({ storageKey: KEY, value: { body: "recovered" }, dirty: true, storage: store }),
    );
    expect(result.current.restored).toEqual({ body: "recovered" });
    expect(result.current.restoredVisible).toBe(true);
  });

  it("has no restore when storage is empty", () => {
    const store = memStorage();
    const { result } = renderHook(() =>
      useDraftAutosave({ storageKey: KEY, value: { body: "" }, dirty: false, storage: store }),
    );
    expect(result.current.restored).toBeNull();
    expect(result.current.restoredVisible).toBe(false);
  });

  it("clear() deletes the draft, hides the notice, and blocks a queued write", () => {
    const store = memStorage();
    const { result, rerender } = renderHook(
      ({ v }: { v: string }) => useDraftAutosave({ storageKey: KEY, value: { body: v }, dirty: v !== "", storage: store, debounceMs: 300 }),
      { initialProps: { v: "typing" } },
    );
    rerender({ v: "typing more" }); // schedules a debounced write
    act(() => result.current.clear());
    act(() => vi.advanceTimersByTime(300)); // the queued write must NOT resurrect the draft
    expect(store._map.has(KEY)).toBe(false);
    expect(result.current.restoredVisible).toBe(false);
  });

  it("acknowledgeRestored hides the notice but keeps the draft", () => {
    const store = memStorage();
    store._map.set(KEY, JSON.stringify({ body: "keep" }));
    const { result } = renderHook(() =>
      useDraftAutosave({ storageKey: KEY, value: { body: "keep" }, dirty: true, storage: store }),
    );
    act(() => result.current.acknowledgeRestored());
    expect(result.current.restoredVisible).toBe(false);
    expect(store._map.has(KEY)).toBe(true);
  });

  it("arms a beforeunload guard only while dirty", () => {
    const add = vi.spyOn(globalThis, "addEventListener");
    const remove = vi.spyOn(globalThis, "removeEventListener");
    const store = memStorage();
    const { rerender, unmount } = renderHook(
      ({ dirty }: { dirty: boolean }) => useDraftAutosave({ storageKey: KEY, value: { body: "x" }, dirty, storage: store }),
      { initialProps: { dirty: false } },
    );
    expect(add).not.toHaveBeenCalledWith("beforeunload", expect.any(Function));
    rerender({ dirty: true });
    expect(add).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    rerender({ dirty: false });
    expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    unmount();
    add.mockRestore();
    remove.mockRestore();
  });

  it("peekDraft reads a stored draft (or null) without mounting the hook", () => {
    const store = memStorage();
    expect(peekDraft(KEY, store)).toBeNull();
    store._map.set(KEY, JSON.stringify({ body: "seed" }));
    expect(peekDraft(KEY, store)).toEqual({ body: "seed" });
  });
});
