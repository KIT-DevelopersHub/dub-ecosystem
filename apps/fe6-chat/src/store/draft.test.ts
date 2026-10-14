import { describe, it, expect } from "vitest";
import { clearDraft, DRAFT_MAX_LEN, getCollapsedSections, loadDraft, saveDraft, setCollapsedSections } from "./draft";

function memStore(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("draft persistence", () => {
  it("saves and restores a draft per channel", () => {
    const s = memStore();
    saveDraft("chn_a", "hello", s);
    expect(loadDraft("chn_a", s)).toBe("hello");
    expect(loadDraft("chn_b", s)).toBe("");
  });

  it("truncates to the max length", () => {
    const s = memStore();
    saveDraft("chn_a", "x".repeat(DRAFT_MAX_LEN + 100), s);
    expect(loadDraft("chn_a", s).length).toBe(DRAFT_MAX_LEN);
  });

  it("removes the key on empty save and on clear", () => {
    const s = memStore();
    saveDraft("chn_a", "hi", s);
    saveDraft("chn_a", "", s);
    expect(loadDraft("chn_a", s)).toBe("");
    saveDraft("chn_a", "again", s);
    clearDraft("chn_a", s);
    expect(loadDraft("chn_a", s)).toBe("");
  });
});

describe("collapsed sidebar sections", () => {
  it("round-trips only the collapsed keys and tolerates junk", () => {
    const s = memStore();
    setCollapsedSections({ sec_1: true, topic: false, dm: true }, s);
    expect(getCollapsedSections(s)).toEqual({ sec_1: true, dm: true });
    setCollapsedSections({}, s);
    expect(getCollapsedSections(s)).toEqual({});
    s.setItem("fe6.chat.collapsedSections", "{not json");
    expect(getCollapsedSections(s)).toEqual({});
  });
});
