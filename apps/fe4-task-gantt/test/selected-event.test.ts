import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { common } from "@dub/types";
import {
  SELECTED_EVENT_STORAGE_KEY,
  loadSelectedEvent,
  saveSelectedEvent,
  useSelectedEvent,
} from "../src/domain/selected-event";

const EVT_A = "evt_a" as common.EventId;
const EVT_B = "evt_b" as common.EventId;

describe("selected-event persistence", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(loadSelectedEvent()).toBeNull();
  });

  it("persists a selected event id and reads it back", () => {
    saveSelectedEvent(EVT_A);
    expect(loadSelectedEvent()).toBe(EVT_A);
    expect(globalThis.localStorage?.getItem(SELECTED_EVENT_STORAGE_KEY)).toBe(EVT_A);
  });

  it("treats blank / whitespace as no selection", () => {
    globalThis.localStorage?.setItem(SELECTED_EVENT_STORAGE_KEY, "   ");
    expect(loadSelectedEvent()).toBeNull();
  });

  it("useSelectedEvent seeds from the route event and persists it on mount", () => {
    const { result } = renderHook(() => useSelectedEvent(EVT_A));
    expect(result.current[0]).toBe(EVT_A);
    // mount mirrors the deep-linked event into storage so the launcher can resume it
    expect(loadSelectedEvent()).toBe(EVT_A);
  });

  it("switchEvent updates state and persists the new event", () => {
    const { result } = renderHook(() => useSelectedEvent(EVT_A));
    act(() => result.current[1](EVT_B));
    expect(result.current[0]).toBe(EVT_B);
    expect(loadSelectedEvent()).toBe(EVT_B);
  });

  it("a changed route event (browser nav) re-seeds state + storage over a prior manual switch", () => {
    const EVT_C = "evt_c" as common.EventId;
    const { result, rerender } = renderHook(({ id }) => useSelectedEvent(id), {
      initialProps: { id: EVT_A },
    });
    act(() => result.current[1](EVT_B));
    expect(loadSelectedEvent()).toBe(EVT_B);
    // shell router re-navigates to a genuinely different event -> prop changes ->
    // state + storage follow the authoritative deep link.
    rerender({ id: EVT_C });
    expect(result.current[0]).toBe(EVT_C);
    expect(loadSelectedEvent()).toBe(EVT_C);
  });
});
