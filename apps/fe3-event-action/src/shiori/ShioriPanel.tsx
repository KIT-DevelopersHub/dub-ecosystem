// ShioriPanel — the action-type panel for kind "shiori". A free block-based
// booklet builder ported from HitoLink's TabiBook: a palette of 7 block types on
// the right, a 4-column canvas on the left where blocks are added, reordered
// (dnd-kit), resized (1–4 column span) and edited inline. Read-only when the
// viewer lacks write permission (same render, no controls) — the shared/viewer
// mode of the original.
//
// Persistence is localStorage keyed by action id (mock/demo friendly, mirrors
// TabiBook). Best-effort mirror to the action payload via onPayloadChange so a
// real backend can pick it up later without changing this component.
//
// Liveness marker: fe3-shiori-editor-v1
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy } from "@dnd-kit/sortable";
import type { ActionPanelProps, ActionTypePlugin } from "../registry/ActionTypeRegistry";
import { BlockPalette } from "./BlockPalette";
import { SortableBlockCard } from "./SortableBlockCard";
import { createBlock, loadDoc, sampleDoc, saveDoc } from "./storage";
import type { ColSpan, ShioriBlock, ShioriBlockType, ShioriDoc } from "./types";
import styles from "./shiori.module.css";

const SHIORI_MARKER = "fe3-shiori-editor-v1";

export function ShioriPanel({ event, action, canWrite }: ActionPanelProps) {
  // Initialise from localStorage, else a seeded sample so an empty booklet is
  // never a blank void on first open.
  const [doc, setDoc] = useState<ShioriDoc>(() => loadDoc(action.id) ?? sampleDoc(event.title));
  const [editingId, setEditingId] = useState<string | null>(null);

  // Undo / redo history (snapshots of blocks).
  const past = useRef<ShioriBlock[][]>([]);
  const future = useRef<ShioriBlock[][]>([]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Persist on every change. localStorage is authoritative for this prototype
  // (mirrors TabiBook), so a real backend round-trip is not required for the
  // booklet to survive reloads. A future integration can mirror `doc` to the
  // action payload via `onPayloadChange` once the P0 contract carries a payload
  // field and version handling is wired through the optimistic mutation.
  useEffect(() => {
    saveDoc(action.id, doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, action.id]);

  const commit = useCallback(
    (nextBlocks: ShioriBlock[]) => {
      past.current.push(doc.blocks);
      future.current = [];
      setDoc({ version: 1, blocks: nextBlocks, updatedAt: new Date().toISOString() });
    },
    [doc.blocks],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(doc.blocks);
    setDoc((d) => ({ ...d, blocks: prev, updatedAt: new Date().toISOString() }));
  }, [doc.blocks]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(doc.blocks);
    setDoc((d) => ({ ...d, blocks: next, updatedAt: new Date().toISOString() }));
  }, [doc.blocks]);

  // Keyboard: Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z redo, Esc exits edit.
  useEffect(() => {
    if (!canWrite) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEditingId(null);
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canWrite, undo, redo]);

  const addBlock = useCallback(
    (type: ShioriBlockType) => {
      commit([...doc.blocks, createBlock(type)]);
    },
    [commit, doc.blocks],
  );

  const updateBlock = useCallback(
    (next: ShioriBlock) => {
      // Inline content edits don't push undo history per keystroke (would be
      // noisy); they update in place. Structural ops (add/remove/reorder/span) do.
      setDoc((d) => ({
        ...d,
        blocks: d.blocks.map((b) => (b.id === next.id ? next : b)),
        updatedAt: new Date().toISOString(),
      }));
    },
    [],
  );

  const removeBlock = useCallback(
    (id: string) => {
      if (editingId === id) setEditingId(null);
      commit(doc.blocks.filter((b) => b.id !== id));
    },
    [commit, doc.blocks, editingId],
  );

  const setSpan = useCallback(
    (id: string, span: ColSpan) => {
      commit(doc.blocks.map((b) => (b.id === id ? { ...b, span } : b)));
    },
    [commit, doc.blocks],
  );

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const from = doc.blocks.findIndex((b) => b.id === active.id);
      const to = doc.blocks.findIndex((b) => b.id === over.id);
      if (from < 0 || to < 0) return;
      commit(arrayMove(doc.blocks, from, to));
    },
    [commit, doc.blocks],
  );

  const ids = useMemo(() => doc.blocks.map((b) => b.id), [doc.blocks]);

  return (
    <div className={styles.layout} data-testid="fe3-shiori-panel" data-marker={SHIORI_MARKER}>
      <div className={styles.canvasWrap}>
        {canWrite && (
          <div className={styles.toolbar}>
            <button type="button" className={styles.miniBtn} onClick={undo} aria-label="元に戻す">
              ↶ 元に戻す
            </button>
            <button type="button" className={styles.miniBtn} onClick={redo} aria-label="やり直す">
              ↷ やり直す
            </button>
            <span className={styles.toolbarHint}>ダブルクリックで編集 / ドラッグで並べ替え</span>
          </div>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <div className={styles.canvas} data-testid="fe3-shiori-canvas">
              {doc.blocks.length === 0 ? (
                <div className={styles.emptyCanvas}>
                  <div className={styles.emptyTitle}>真っ白なしおり</div>
                  <p>右のパレットからブロックを追加してください。</p>
                </div>
              ) : (
                doc.blocks.map((b) => (
                  <SortableBlockCard
                    key={b.id}
                    block={b}
                    editing={editingId === b.id}
                    canWrite={canWrite}
                    onChange={updateBlock}
                    onRemove={removeBlock}
                    onSetSpan={setSpan}
                    onEnterEdit={setEditingId}
                  />
                ))
              )}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {canWrite && <BlockPalette onAdd={addBlock} />}
    </div>
  );
}

/** ActionTypePlugin for kind "shiori" — register at FE2 app init (see index.ts). */
export const shioriActionPlugin: ActionTypePlugin = {
  type: "shiori",
  label: "しおり",
  icon: "calendar",
  Panel: ShioriPanel,
};
