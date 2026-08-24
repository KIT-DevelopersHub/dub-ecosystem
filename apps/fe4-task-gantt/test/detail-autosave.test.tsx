// Auto-save (保存ボタン廃止): the detail panel persists edits for the user after a
// short debounce — no 保存 button. Covers: button removal, debounce coalescing of a
// burst of edits into ONE patch, and the 保存中…→保存しました / 保存に失敗しました
// (rollback) indicator states.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { task } from "@dub/types";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";

const mkTask = (id: string): task.Task => ({
  id, eventId: "evt_1", title: "元タイトル", description: null, status: "todo",
  priority: "medium", assigneeId: null, teamId: null, startAt: null, dueAt: "2026-09-15T00:00:00.000Z",
  origin: "internal", archivedAt: null, createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z", version: 1,
});

const base = (over: Partial<Parameters<typeof TaskDetailPanel>[0]> = {}) => ({
  task: mkTask("t1"),
  users: [],
  canWrite: true,
  canDelete: true,
  onSave: () => {},
  onDelete: () => {},
  onClose: () => {},
  ...over,
});

describe("TaskDetailPanel — auto-save (保存ボタン廃止)", () => {
  it("renders NO 保存 button — an auto-save status indicator replaces it", () => {
    render(<TaskDetailPanel {...base()} />);
    expect(screen.queryByTestId("fe4-detail-save")).toBeNull();
    expect(screen.getByTestId("fe4-detail-save-status")).toHaveAttribute("data-state", "idle");
  });

  it("does not fire on mount (no spurious save when nothing changed)", async () => {
    const onSave = vi.fn();
    render(<TaskDetailPanel {...base({ onSave, autosaveDebounceMs: 0 })} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("debounces a burst of edits into ONE coalesced patch", async () => {
    const onSave = vi.fn();
    render(<TaskDetailPanel {...base({ onSave, autosaveDebounceMs: 80 })} />);
    // two rapid edits within the debounce window → a single save carrying both fields
    fireEvent.change(screen.getByTestId("fe4-detail-title"), { target: { value: "新タイトル" } });
    fireEvent.change(screen.getByTestId("fe4-detail-priority"), { target: { value: "high" } });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [patch] = onSave.mock.calls[0]!;
    expect(patch.title).toBe("新タイトル");
    expect(patch.priority).toBe("high");
    // …and it settles at exactly one call (the first timer was cleared, not double-fired)
    await new Promise((r) => setTimeout(r, 120));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("shows 保存しました after a successful save", async () => {
    const onSave = vi.fn(() => Promise.resolve(true));
    render(<TaskDetailPanel {...base({ onSave, autosaveDebounceMs: 0 })} />);
    fireEvent.change(screen.getByTestId("fe4-detail-title"), { target: { value: "保存される" } });
    await waitFor(() =>
      expect(screen.getByTestId("fe4-detail-save-status")).toHaveAttribute("data-state", "saved"),
    );
    expect(screen.getByTestId("fe4-detail-save-status")).toHaveTextContent("保存しました");
  });

  it("shows 保存に失敗しました when the save fails (optimistic rollback path)", async () => {
    const onSave = vi.fn(() => Promise.resolve(false));
    render(<TaskDetailPanel {...base({ onSave, autosaveDebounceMs: 0 })} />);
    fireEvent.change(screen.getByTestId("fe4-detail-title"), { target: { value: "失敗する" } });
    await waitFor(() =>
      expect(screen.getByTestId("fe4-detail-save-status")).toHaveAttribute("data-state", "error"),
    );
    expect(screen.getByTestId("fe4-detail-save-status")).toHaveTextContent("保存に失敗しました");
  });

  it("read-only (canWrite=false) never auto-saves and shows no status", async () => {
    const onSave = vi.fn();
    render(<TaskDetailPanel {...base({ onSave, canWrite: false, autosaveDebounceMs: 0 })} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByTestId("fe4-detail-save-status")).toBeNull();
  });
});
