// Mutation hooks. Edits go through createOptimisticMutation (optimistic + rollback
// + version-conflict refetch). Creates and destructive archives are NON-optimistic
// (design 1-2-6: destructive ops run after ConfirmDialog, no optimism).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { common, event } from "@dub/types";
import { useEventApi } from "../context/ApiContext";
import { useToast } from "../contracts/fe1";
import { toDisplayableError } from "../contracts/fe2";
import { createOptimisticMutation } from "./useOptimisticMutation";
import { eventKeys } from "../lib/queryKeys";
import type { CreateActionRequest, ListActionsResponse, UpdateActionRequest } from "../api/actionContracts";

// ---- Event: create (non-optimistic; server mints id) ----
export function useCreateEvent() {
  const api = useEventApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<event.DubEvent, unknown, event.CreateEventRequest>({
    mutationFn: (req) => api.createEvent(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: eventKeys.lists() });
      toast.show({ message: "イベントを作成しました", variant: "success" });
    },
    onError: (err) => toast.show({ message: toDisplayableError(err).message, variant: "error" }),
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
      toast.show({ message: "イベントをアーカイブしました", variant: "success" });
    },
    onError: (err) => toast.show({ message: toDisplayableError(err).message, variant: "error" }),
  });
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
      toast.show({ message: "アクションを作成しました", variant: "success" });
    },
    onError: (err) => toast.show({ message: toDisplayableError(err).message, variant: "error" }),
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
      toast.show({ message: "アクションをアーカイブしました", variant: "success" });
    },
    onError: (err) => toast.show({ message: toDisplayableError(err).message, variant: "error" }),
  });
}
