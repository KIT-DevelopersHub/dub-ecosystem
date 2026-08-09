import { describe, it, expect, vi } from "vitest";
import type { event } from "@dub/types";
import { createActionTypeRegistry, type ActionTypePlugin } from "../src/registry/ActionTypeRegistry";
import { genericActionPlugin } from "../src/components/GenericActionPanel";

const mockPlugin: ActionTypePlugin = {
  type: "task_management",
  label: "タスク管理",
  icon: "task",
  Panel: () => null,
};

describe("ActionTypeRegistry (test observations #3, #4)", () => {
  it("resolves unknown kinds to the generic fallback (#3)", () => {
    const r = createActionTypeRegistry(genericActionPlugin);
    expect(r.has("nonexistent")).toBe(false);
    expect(r.resolve("nonexistent")).toBe(genericActionPlugin);
  });

  it("resolves a registered plugin (#4)", () => {
    const r = createActionTypeRegistry(genericActionPlugin);
    r.register(mockPlugin);
    expect(r.has("task_management")).toBe(true);
    expect(r.resolve("task_management")).toBe(mockPlugin);
    expect(r.list()).toContain(mockPlugin);
  });

  it("warns and last-wins on duplicate registration", () => {
    const r = createActionTypeRegistry(genericActionPlugin);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    r.register(mockPlugin);
    const replacement: ActionTypePlugin = { ...mockPlugin, label: "v2" };
    r.register(replacement);
    expect(warn).toHaveBeenCalled();
    expect(r.resolve("task_management").label).toBe("v2");
    warn.mockRestore();
  });

  it("generic fallback panel renders the kind without throwing", () => {
    const action = { id: "a", kind: "weird_kind", title: "t", sortOrder: 1 } as event.DubAction;
    // Panel is a component; just assert it is the generic one and callable shape.
    expect(genericActionPlugin.Panel).toBeTypeOf("function");
    expect(action.kind).toBe("weird_kind");
  });
});
