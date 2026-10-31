import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDebouncedValue } from "../src/hooks/useDebouncedValue";
import { useClientFilter, normalizeSearchText, matchesSearch } from "../src/hooks/useClientFilter";

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("only settles after the value stops changing for `ms`", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), { initialProps: { v: "" } });
    rerender({ v: "a" });
    act(() => vi.advanceTimersByTime(100));
    rerender({ v: "ab" });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe("");
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe("ab");
  });

  it("defaults to 250ms", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(2);
  });
});

describe("normalizeSearchText / matchesSearch", () => {
  it("folds width, case and katakana→hiragana, and trims", () => {
    expect(normalizeSearchText("  ＡＢＣ　タナカ ")).toBe("abc たなか");
    expect(normalizeSearchText("ﾀﾅｶ")).toBe("たなか");
  });

  it("is a substring match on the whole term (like the server's LIKE)", () => {
    expect(matchesSearch("メンバー 01", "めんばー 0")).toBe(true);
    expect(matchesSearch("メンバー 10", "メンバー 0")).toBe(false);
    expect(matchesSearch("Taro@Example.com", "ＥＸＡＭＰＬＥ")).toBe(true);
    expect(matchesSearch("anything", "   ")).toBe(true);
  });
});

describe("useClientFilter", () => {
  const items = [
    { id: "1", name: "たなか", email: "tanaka@example.com" },
    { id: "2", name: "スズキ", email: "suzuki@example.com" },
  ];
  const getText = (u: (typeof items)[number]) => `${u.name} ${u.email}`;

  it("returns the input array untouched for an empty term", () => {
    const { result } = renderHook(() => useClientFilter(items, " ", getText));
    expect(result.current.results).toBe(items);
  });

  it("matches across kana/width/case", () => {
    const { result, rerender } = renderHook(({ q }) => useClientFilter(items, q, getText), {
      initialProps: { q: "タナカ" },
    });
    expect(result.current.results.map((u) => u.id)).toEqual(["1"]);
    rerender({ q: "すずき" });
    expect(result.current.results.map((u) => u.id)).toEqual(["2"]);
    rerender({ q: "EXAMPLE" });
    expect(result.current.results).toHaveLength(2);
    rerender({ q: "nobody" });
    expect(result.current.results).toHaveLength(0);
  });
});
