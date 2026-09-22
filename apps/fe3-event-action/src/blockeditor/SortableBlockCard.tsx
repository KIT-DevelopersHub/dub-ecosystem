// A single block on the canvas: dnd-kit sortable wrapper + hover toolbar
// (drag handle / span control / delete). Double-click to toggle inline edit.
// Read-only (view mode) renders the same content with no controls and no card
// chrome, so the block layout reads as page content.
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BlockContent } from "./blocks";
import type { Block, ColSpan } from "./types";
import styles from "./blockeditor.module.css";

type Props = {
  block: Block;
  editing: boolean;
  canWrite: boolean;
  onChange: (next: Block) => void;
  onRemove: (id: string) => void;
  onSetSpan: (id: string, span: ColSpan) => void;
  onEnterEdit: (id: string) => void;
};

export function SortableBlockCard({
  block,
  editing,
  canWrite,
  onChange,
  onRemove,
  onSetSpan,
  onEnterEdit,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    disabled: !canWrite || editing,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    gridColumn: `span ${block.span}`,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${styles.card} ${editing ? styles.editing : ""} ${isDragging ? styles.dragging : ""} ${
        canWrite ? "" : styles.readonly
      }`}
      data-testid={`fe3-blockeditor-block-${block.type}`}
      onDoubleClick={() => canWrite && !editing && onEnterEdit(block.id)}
    >
      {canWrite && (
        <div className={styles.cardBar}>
          <div className={styles.spanControl} role="group" aria-label="幅">
            {([1, 2, 3, 4] as ColSpan[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`${styles.spanBtn} ${block.span === s ? styles.active : ""}`}
                aria-label={`幅 ${s}/4`}
                aria-pressed={block.span === s}
                onClick={() => onSetSpan(block.id, s)}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.dragHandle}`}
            aria-label="ドラッグして並べ替え"
            {...attributes}
            {...listeners}
          >
            ⠿
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="ブロックを削除"
            onClick={() => onRemove(block.id)}
          >
            ×
          </button>
        </div>
      )}
      <BlockContent block={block} editing={editing} onChange={onChange} />
    </div>
  );
}
