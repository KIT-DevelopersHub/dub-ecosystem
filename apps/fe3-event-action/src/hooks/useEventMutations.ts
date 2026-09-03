// Mutation hooks. Edits go through createOptimisticMutation (optimistic + rollback
// + version-conflict refetch). Creates and destructive archives are NON-optimistic
// (design 1-2-6: destructive ops run after ConfirmDialog, no optimism).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { common, event } from "@dub/types";
import { useEventApi } from "../context/ApiContext";
import { useToast } from "@dub/ui";
import { useUndoableAction } from "@dub/app-ui";
import { createOptimisticMutation } from "./useOptimisticMutation";
import { eventKeys } from "../lib/queryKeys";
import { normalizeError } from "../lib/errorMap";
import type { CreateActionRequest, ListActionsResponse, UpdateActionRequest } from "../api/actionContracts";
import type { EventDetails, EventDetailsData } from "../api/detailsContracts";

// ---- Event: create (non-optimistic; server mints id) ----
export function useCreateEvent() {
  const api = useEventApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<event.DubEvent, unknown, event.CreateEventRequest>({
    mutationFn: (req) => api.createEvent(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: eventKeys.lists() });
      toast.show({ kind: "success", title: "イベントを作成しました" });
    },
    onError: (err) => toast.show({ kind: "error", title: normalizeError(err).message }),
  });
}

// ---- Event: update / phase transition (optimistic on the detail cache) ----
export function useUpdateEvent(eventId: common.EventId) {
  const api = useEventApi();
  return createOptimisticMutation<event.DubEvent, event.UpdateEventRequest, event.GetEventResponse>({
    mutationFn: (req) => api.updateEvent(eventId, req),
    queryKey: eventKeys.detail(eventId),
    optimisticUpdate: (prev, vars) => {
      if (!prev) return prev;
      return {
        ...prev,
        title: vars.title ?? prev.title,
        description: vars.description !== undefined ? vars.description : prev.description,
        phase: vars.phase ?? prev.phase,
        startsAt: vars.startsAt !== undefined ? vars.startsAt : prev.startsAt,
        endsAt: vars.endsAt !== undefined ? vars.endsAt : prev.endsAt,
      };
    },
    successMessage: "保存しました",
  });
}

// ---- Event details: save the free-form store (optimistic on the details cache) ----
// The whole document is saved at once. The panel passes the next `data` plus the
// `version` it read, so the optimistic patch swaps data + bumps version pending the
// server echo, and a stale version yields EVENT_VERSION_CONFLICT (rollback+refetch).
export interface SaveDetailsVars {
  data: EventDetailsData;
  version: number;
}
export function useSaveEventDetails(eventId: common.EventId) {
  const api = useEventApi();
  return createOptimisticMutation<EventDetails, SaveDetailsVars, EventDetails>({
    mutationFn: ({ data, version }) => api.saveEventDetails(eventId, { data, version }),
    queryKey: eventKeys.eventDetails(eventId),
    optimisticUpdate: (prev, { data }) => {
      if (!prev) return prev;
      return { ...prev, data, version: prev.version + 1 };
    },
    successMessage: "保存しました",
  });
}

// ---- Event: archive (non-optimistic; destructive after ConfirmDialog) ----
export function useArchiveEvent(eventId: common.EventId) {
  const api = useEventApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<void, unknown, void>({
    mutationFn: () => api.archiveEvent(eventId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: eventKeys.lists() });
      void qc.invalidateQueries({ queryKey: eventKeys.detail(eventId) });
      toast.show({ kind: "success", title: "イベントをアーカイブしました" });
    },
    onError: (err) => toast.show({ kind: "error", title: normalizeError(err).message }),
  });
}

// ---- Action: archive with UNDO (delayed-commit; optimistic on the actions list) ----
// The board stays mounted through the grace window, so the "元に戻す" toast + deferred
// DELETE work here (unlike event-archive, which navigates away). Removes the row
// instantly, defers api.archiveAction, and re-inserts it if the user undoes or the
// commit fails ([[optimistic-ui-principle]], FRONTEND_GUIDE §5.3 + ⑤ 取り消し).
export function useUndoableArchiveAction(eventId: common.EventId) {
  const api = useEventApi();
  const qc = useQueryClient();
  const toast = useToast();
  const undoable = useUndoableAction();
  const key = eventKeys.actions(eventId);
  return (action: event.DubAction) => {
    const previous = qc.getQueryData<ListActionsResponse>(key);
    undoable.run({
      message: "アクションを削除しました",
      apply: () => {
        qc.setQueryData<ListActionsResponse>(key, (prev) =>
          prev ? { ...prev, items: prev.items.filter((a) => a.id !== action.id) } : prev,
        );
      },
      restore: () => {
        if (previous !== undefined) qc.setQueryData<ListActionsResponse>(key, previous);
      },
      commit: async () => {
        await api.archiveAction(action.id);
        void qc.invalidateQueries({ queryKey: key });
        void qc.invalidateQueries({ queryKey: eventKeys.detail(eventId) });
      },
      onCommitError: (err) => {
        if (previous !== undefined) qc.setQueryData<ListActionsResponse>(key, previous);
        toast.show({ kind: "error", title: normalizeError(err).message });
      },
    });
  };
}

// ---- Action: create (non-optimistic) ----
export function useCreateAction(eventId: common.EventId) {
  const api = useEventApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<event.DubAction, unknown, CreateActionRequest>({
    mutationFn: (req) => api.createAction(eventId, req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: eventKeys.actions(eventId) });
      void qc.invalidateQueries({ queryKey: eventKeys.detail(eventId) });
      toast.show({ kind: "success", title: "アクションを作成しました" });
    },
    onError: (err) => toast.show({ kind: "error", title: normalizeError(err).message }),
  });
}

interface UpdateActionVars {
  actionId: common.ActionId;
  req: UpdateActionRequest;
}

// ---- Action: update title/kind/sortOrder/payload (optimistic on actions list) ----
export function useUpdateAction(eventId: common.EventId) {
  const api = useEventApi();
  return createOptimisticMutation<event.DubAction, UpdateActionVars, ListActionsResponse>({
    mutationFn: ({ actionId, req }) => api.updateAction(actionId, req),
    queryKey: eventKeys.actions(eventId),
    optimisticUpdate: (prev, { actionId, req }) => {
      if (!prev) return prev;
      const items = prev.items
        .map((a) =>
          a.id === actionId
            ? {
                ...a,
                title: req.title ?? a.title,
                kind: req.kind ?? a.kind,
                sortOrder: req.sortOrder ?? a.sortOrder,
              }
            : a,
        )
        .sort((x, y) => x.sortOrder - y.sortOrder);
      return { ...prev, items };
    },
  });
}

// ---- Action: archive (non-optimistic; destructive) ----
export function useArchiveAction(eventId: common.EventId) {
  const api = useEventApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<void, unknown, common.ActionId>({
    mutationFn: (actionId) => api.archiveAction(actionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: eventKeys.actions(eventId) });
      toast.show({ kind: "success", title: "アクションをアーカイブしました" });
    },
    onError: (err) => toast.show({ kind: "error", title: normalizeError(err).message }),
  });
}
