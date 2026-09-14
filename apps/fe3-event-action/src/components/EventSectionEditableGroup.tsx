// Inline 編集モード for one group of the Event detail page's sections (重要リンク /
// 連絡先 / 概要 / ... — see EventDetailsPanel). Ported from FE2's HomeEditableRegion
// (P3-3): the viewer taps "編集" and the REAL sections become the draggable rows —
// iOS ホーム画面編集 style (light jiggle + dashed frame + a grip handle + a per-section
// hide toggle). Tapping "完了" commits and exits.
//
// Difference from Home: this layout is SHARED (event-scoped, not per-viewer) and only
// rendered in edit mode for callers that already checked event:write — the panel
// gates the "編集" toggle itself; this component just needs `isEditing` + the two
// commit callbacks.
//
// `SortableList` (@dub/ui) is the one drag primitive per FRONTEND_GUIDE "並べ替え UI".
import { Fragment } from "react";
import { Icon, SortableList, type SortableReorderEvent } from "@dub/ui";
import {
  mergeGroupOrder,
  groupOrdered,
  visibleGroup,
  moveTo,
  type SectionGroup,
  type SectionMeta,
} from "../lib/sectionLayout";
import styles from "./components.module.css";

export function EventSectionEditableGroup({
  group,
  catalog,
  order,
  hidden,
  nodes,
  isEditing,
  className,
  groupLabel,
  testId,
  containerAriaLabel,
  onReorderGroup,
  onSetHidden,
}: {
  group: SectionGroup;
  catalog: SectionMeta[];
  order: string[];
  hidden: string[];
  /** Rendered node per section id (the SAME node used outside edit mode). */
  nodes: Record<string, React.ReactNode>;
  isEditing: boolean;
  /** Class on the group's own container — kept identical in and out of edit mode so
   *  the surrounding grid never shifts. */
  className?: string;
  /** aria-label for the sortable list while editing (announced by dnd-kit). */
  groupLabel: string;
  /** testid on the group's own container — stable across edit-mode toggles. */
  testId?: string;
  /** aria-label applied to the resting (non-editing) container, if needed. */
  containerAriaLabel?: string;
  /** Commit the FULL next preferred order (already merged across all groups). */
  onReorderGroup: (nextOrder: string[]) => void;
  /** Show or hide a single section by id. */
  onSetHidden: (id: string, hidden: boolean) => void;
}): JSX.Element {
  const hiddenSet = new Set(hidden);
  const resolvedTestId = testId ?? `fe3-section-group-${group}`;

  if (!isEditing) {
    const visible = visibleGroup(catalog, order, hidden, group);
    return (
      <div className={className} data-testid={resolvedTestId} {...(containerAriaLabel ? { "aria-label": containerAriaLabel } : {})}>
        {visible.map((s) => (
          <Fragment key={s.id}>{nodes[s.id]}</Fragment>
        ))}
      </div>
    );
  }

  // Editing: EVERY section of the group, hidden or not (hidden ones render dimmed
  // with a "表示する" toggle so removing one is reversible without leaving edit mode).
  const items = groupOrdered(catalog, order, group);
  if (items.length === 0) return <></>;

  const onReorder = (e: SortableReorderEvent): void => {
    const ids = items.map((s) => s.id);
    const next = moveTo(ids, e.oldIndex, e.newIndex);
    onReorderGroup(mergeGroupOrder(catalog, order, group, next));
  };

  return (
    <SortableList<SectionMeta>
      items={items}
      getItemId={(s) => s.id}
      onReorder={onReorder}
      className={className}
      aria-label={`${groupLabel}の並べ替え`}
      testId={resolvedTestId}
      renderItem={(s, ctx) => {
        const isHidden = hiddenSet.has(s.id);
        return (
          <div
            className={styles.sectionEdit}
            data-testid={`fe3-section-edit-${s.id}`}
            data-hidden={isHidden}
            data-dragging={ctx.isDragging || undefined}
          >
            <button
              type="button"
              className={styles.sectionEditHide}
              aria-pressed={!isHidden}
              aria-label={isHidden ? `${s.label}を表示する` : `${s.label}を非表示にする`}
              data-testid={`fe3-section-hide-${s.id}`}
              onClick={() => onSetHidden(s.id, !isHidden)}
            >
              <Icon name={isHidden ? "plus" : "x"} />
            </button>
            <span
              className={styles.sectionEditHandle}
              aria-label={`${s.label}をドラッグして並べ替え`}
              data-testid={`fe3-section-handle-${s.id}`}
              {...ctx.dragHandleProps}
            >
              <Icon name="drag" />
            </span>
            <div className={styles.sectionEditInner} data-hidden={isHidden} aria-hidden={isHidden || undefined}>
              {nodes[s.id]}
            </div>
          </div>
        );
      }}
    />
  );
}
