import { useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { common, event } from "@dub/types";
import { Icon, IconButton, Button, SkeletonList } from "@dub/ui";
import { ActionCard } from "./ActionCard";
import { ActionCreateModal } from "./ActionCreateModal";
import { ConfirmDialog } from "./ConfirmDialog";
import { useActionsQuery } from "../hooks/useEventQueries";
import { useUpdateAction, useUndoableArchiveAction } from "../hooks/useEventMutations";
import { computeReorder } from "../lib/sortOrder";
import styles from "./components.module.css";

function SortableActionRow({
  action,
  canWrite,
  onOpen,
  onDelete,
}: {
  action: event.DubAction;
  canWrite: boolean;
  onOpen?: (id: string) => void;
  onDelete?: (action: event.DubAction) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: action.id,
    disabled: !canWrite,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <div className={styles.actionRow}>
        {canWrite ? (
          <span className={styles.dragHandle} {...attributes} {...listeners} data-testid={`fe3-actionboard-drag-${action.id}`}>
            <Icon name="menu" aria-label="ドラッグして並べ替え" />
          </span>
        ) : null}
        <div style={{ flex: 1 }}>
          <ActionCard action={action} onOpen={onOpen} />
        </div>
        {onDelete ? (
          <IconButton
            name="trash"
            aria-label="アクションを削除"
            onClick={() => onDelete(action)}
            testId={`fe3-actionboard-delete-${action.id}`}
          />
        ) : null}
      </div>
    </div>
  );
}

export function ActionBoard({
  eventId,
  canWrite,
  onOpenAction,
}: {
  eventId: common.EventId;
  canWrite: boolean;
  onOpenAction?: (actionId: string) => void;
}) {
  const [kindFilter, setKindFilter] = useState<string>("");
  const query = useActionsQuery(eventId, kindFilter ? { kind: kindFilter } : undefined);
  const update = useUpdateAction(eventId);
  const archiveAction = useUndoableArchiveAction(eventId);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<event.DubAction | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const items = query.data?.items ?? [];
  const kinds = useMemo(() => [...new Set(items.map((a) => a.kind))], [items]);

  const onDragEnd = (e: DragEndEvent) => {
    const overId = e.over?.id;
    if (!overId || e.active.id === overId) return;
    // Visual order after the move (for optimistic display consistency).
    const ordered = arrayMove(
      items,
      items.findIndex((i) => i.id === e.active.id),
      items.findIndex((i) => i.id === overId),
    );
    void ordered; // arrayMove result is implied by the sortOrder PATCH below.
    const result = computeReorder(items, String(e.active.id), String(overId));
    if (!result) return;
    const moved = items.find((i) => i.id === result.id);
    if (!moved) return;
    if (result.needsNormalization) {
      // Gap exhausted: ask the server to normalize by refetching (server re-stripes).
      void query.refetch();
      return;
    }
    update.mutate({ actionId: moved.id, req: { version: moved.version, sortOrder: result.sortOrder } });
  };

  return (
    <div data-testid="fe3-actionboard">
      <div className={styles.toolbar}>
        <select
          className={styles.select}
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          data-testid="fe3-actionboard-kind-filter"
        >
          <option value="">すべての種別</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <span className={styles.spacer} />
        {canWrite ? (
          <Button iconLeft={<Icon name="plus" />} variant="primary" onClick={() => setCreateOpen(true)} testId="fe3-actionboard-create">
            アクションを追加
          </Button>
        ) : null}
      </div>

      {query.isLoading ? (
        // Loading MUST show a skeleton, never a bare blank, so the user can tell
        // "loading" from "empty" (FRONTEND_GUIDE §5).
        <div className={styles.board} data-testid="fe3-actionboard-skeleton">
          <SkeletonList rows={5} />
        </div>
      ) : items.length === 0 ? (
        <div className={styles.emptyState}>アクションがありません</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((a) => a.id)} strategy={verticalListSortingStrategy}>
            <div className={styles.board}>
              {items.map((a) => (
                <SortableActionRow
                  key={a.id}
                  action={a}
                  canWrite={canWrite}
                  onOpen={onOpenAction}
                  onDelete={canWrite ? setPendingDelete : undefined}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <ActionCreateModal
        eventId={eventId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        knownKinds={kinds}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="アクションを削除しますか？"
        message="削除後、数秒間は「元に戻す」で取り消せます。"
        confirmLabel="削除する"
        onConfirm={() => {
          if (pendingDelete) archiveAction(pendingDelete);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
        testId="fe3-actionboard-delete-confirm"
      />
    </div>
  );
}
