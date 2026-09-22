// BlockEditor — a reusable widget-canvas editor generalised from the しおり
// (event booklet) panel. A palette of 7 block types on the right, a 4-column
// canvas on the left where blocks are added, reordered (dnd-kit), resized (1–4
// column span) and edited inline. When `canWrite` is false it renders the same
// blocks read-only (no palette, no toolbar, no card chrome) — the viewer mode.
//
// Persistence is localStorage keyed by `storageKey` (mock/demo friendly). The
// caller decides the key: an action id for the しおり panel, an event id for the
// event-page inline editor. A real D1 persistence layer can replace loadDoc/
// saveDoc later without touching this component (next stage).
//
// Liveness marker: fe3-event-inline-edit-v1
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
import { BlockPalette } from "./BlockPalette";
import { SortableBlockCard } from "./SortableBlockCard";
import { createBlock, emptyDoc, loadDoc, saveDoc } from "./storage";
import type { Block, BlockDoc, BlockType, ColSpan } from "./types";
import styles from "./blockeditor.module.css";

export const BLOCK_EDITOR_MARKER = "fe3-event-inline-edit-v1";

export interface BlockEditorProps {
  /** localStorage partition (event id / action id / …). */
  storageKey: string;
  /** Edit affordances (palette, toolbar, drag, inline edit) are gated on this. */
  canWrite: boolean;
  /** When storage is empty and this is set, seed the canvas with `seed`. */
  seed?: BlockDoc;
  /** Notified after every change so the caller can mirror to a backend later. */
  onDocChange?: (doc: BlockDoc) => void;
}

export function BlockEditor({ storageKey, canWrite, seed, onDocChange }: BlockEditorProps) {
  const [doc, setDoc] = useState<BlockDoc>(() => loadDoc(storageKey) ?? seed ?? emptyDoc());
  const [editingId, setEditingId] = useState<string | null>(null);

  // Undo / redo history (snapshots of blocks).
  const past = useRef<Block[][]>([]);
  const future = useRef<Block[][]>([]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Persist on every change; mirror out for a future backend integration.
  useEffect(() => {
    saveDoc(storageKey, doc);
    onDocChange?.(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, storageKey]);

  const commit = useCallback(
    (nextBlocks: Block[]) => {
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
    (type: BlockType) => {
      commit([...doc.blocks, createBlock(type)]);
    },
    [commit, doc.blocks],
  );

  const updateBlock = useCallback((next: Block) => {
    // Inline content edits update in place (not pushed to undo per keystroke).
    setDoc((d) => ({
      ...d,
      blocks: d.blocks.map((b) => (b.id === next.id ? next : b)),
      updatedAt: new Date().toISOString(),
    }));
  }, []);

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

  // View mode with no content: render nothing (the page shows its structured data
  // instead of an empty editor frame).
  if (!canWrite && doc.blocks.length === 0) return null;

  return (
    <div className={styles.layout} data-testid="fe3-blockeditor" data-marker={BLOCK_EDITOR_MARKER}>
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
            <div
              className={`${styles.canvas} ${canWrite ? "" : styles.canvasReadonly}`}
              data-testid="fe3-blockeditor-canvas"
            >
              {doc.blocks.length === 0 ? (
                <div className={styles.emptyCanvas}>
                  <div className={styles.emptyTitle}>まだブロックがありません</div>
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
