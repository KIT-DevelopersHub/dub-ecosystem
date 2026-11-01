// カレンダー > ミーティング: permission gate + queries/mutations (optimistic, rollback on error).
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import type { meeting } from "@dub/types";
import { useAppCapability, usePermissions } from "../../auth/AuthProvider.tsx";
import { ApiError } from "../../lib/api-client.tsx";
import { createOptimisticMutation } from "../../lib/optimistic.tsx";
import type { CalendarApi } from "./calendarApi.tsx";
import { useCalendarApi } from "./CalendarProvider.tsx";

export const MEETINGS_KEY = ["calendar", "meetings"] as const;
export const MEETING_TARGETS_KEY = ["calendar", "meeting-targets"] as const;

/** Same gate as the server: view = カレンダー 閲覧 + meetings_view, edit = カレンダー 編集 + meetings_edit. */
export function useMeetingsAccess(): { canView: boolean; canEdit: boolean } {
  const { can } = usePermissions();
  const app = useAppCapability("calendar");
  const canEdit = app.canEdit && can("calendar:meetings_edit");
  return { canView: canEdit || (app.canView && can("calendar:meetings_view")), canEdit };
}

/** Google Calendar is the source of truth; each list pulls the server sync close, so re-read
 *  while the page is shown to follow edits / deletions made there. */
const MEETINGS_REFETCH_MS = 60_000;

export function useMeetingsQuery(enabled: boolean) {
  const api = useCalendarApi();
  return useQuery({ queryKey: MEETINGS_KEY, queryFn: () => api.listMeetings(), enabled, refetchInterval: MEETINGS_REFETCH_MS });
}

export function useMeetingTargetsQuery(enabled: boolean) {
  const api = useCalendarApi();
  return useQuery({ queryKey: MEETING_TARGETS_KEY, queryFn: () => api.listMeetingTargets(), enabled, staleTime: 60_000 });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "もう一度お試しください。";
}

type Cache = meeting.ListMeetingsResponse;

/** Re-read the list this long after an ambiguous create failure (the server may still be finishing). */
const RECHECK_DELAYS_MS = [0, 3_000, 6_000] as const;

/** A timeout / 5xx / dropped connection does not mean the meeting was not made. */
function mayHaveCreated(err: unknown): boolean {
  return ApiError.isApiError(err) && (err.status === 0 || err.status >= 500);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The meeting `body` created, if a fresh list has one that was not there before. */
export async function findCreatedMeeting(
  api: Pick<CalendarApi, "listMeetings">,
  body: meeting.CreateMeetingRequest,
  known: ReadonlySet<string>,
  delays: readonly number[] = RECHECK_DELAYS_MS,
): Promise<meeting.Meeting | null> {
  const at = Date.parse(body.startsAt);
  for (const wait of delays) {
    if (wait > 0) await sleep(wait);
    const list = await api.listMeetings().catch(() => null);
    const hit = list?.items.find(
      (m) => !known.has(m.id) && m.title === body.title && m.targetId === body.targetId && Date.parse(m.startsAt) === at,
    );
    if (hit) return hit;
  }
  return null;
}
type Mutation<D, V> = UseMutationResult<D, ApiError, V, unknown>;

export interface MeetingMutations {
  create: Mutation<meeting.Meeting, meeting.CreateMeetingRequest>;
  update: Mutation<meeting.Meeting, { id: string; body: meeting.UpdateMeetingRequest }>;
  remove: Mutation<void, string>;
  sync: Mutation<meeting.SyncMeetingsResponse, void>;
}

export function useMeetingMutations(targets: readonly meeting.MeetingTarget[]): MeetingMutations {
  const api = useCalendarApi();
  const qc = useQueryClient();
  const toast = useToast();
  const targetName = (id: string) => targets.find((t) => t.id === id)?.name ?? "";
  const fail = (title: string) => (err: unknown) => toast.show({ kind: "error", title, description: errorText(err) });

  const create = useMutation(
    createOptimisticMutation<meeting.Meeting, meeting.CreateMeetingRequest, Cache>(qc, {
      mutationFn: async (body) => {
        const known = new Set((qc.getQueryData<Cache>(MEETINGS_KEY)?.items ?? []).map((m) => m.id));
        try {
          return await api.createMeeting(body);
        } catch (err) {
          // Shown as a failure only when the list confirms nothing was made.
          if (!mayHaveCreated(err)) throw err;
          const made = await findCreatedMeeting(api, body, known);
          if (made) return made;
          throw err;
        }
      },
      cacheKey: MEETINGS_KEY,
      applyOptimistic: (prev, body) => {
        const now = new Date().toISOString();
        const temp: meeting.Meeting = {
          id: `tmp_${Date.now().toString(36)}`,
          title: body.title,
          description: body.description ?? null,
          targetId: body.targetId,
          targetName: targetName(body.targetId),
          startsAt: body.startsAt,
          durationMinutes: body.durationMinutes,
          recurrence: body.recurrence,
          until: body.until ?? null,
          meetUrl: null,
          htmlLink: null,
          attendeeCount: 0,
          createdBy: "" as meeting.Meeting["createdBy"],
          createdAt: now,
          updatedAt: now,
        };
        return { ...prev, items: [...prev.items, temp] };
      },
      onErrorToast: fail("ミーティングを登録できませんでした"),
    }),
  );

  const update = useMutation(
    createOptimisticMutation<meeting.Meeting, { id: string; body: meeting.UpdateMeetingRequest }, Cache>(qc, {
      mutationFn: ({ id, body }) => api.updateMeeting(id, body),
      cacheKey: MEETINGS_KEY,
      applyOptimistic: (prev, { id, body }) => ({
        ...prev,
        items: prev.items.map((m) =>
          m.id === id ? { ...m, ...body, ...(body.targetId ? { targetName: targetName(body.targetId) } : {}) } as meeting.Meeting : m,
        ),
      }),
      onErrorToast: fail("ミーティングを更新できませんでした"),
    }),
  );

  const remove = useMutation(
    createOptimisticMutation<void, string, Cache>(qc, {
      mutationFn: (id) => api.deleteMeeting(id),
      cacheKey: MEETINGS_KEY,
      applyOptimistic: (prev, id) => ({ ...prev, items: prev.items.filter((m) => m.id !== id) }),
      onErrorToast: fail("ミーティングを削除できませんでした"),
    }),
  );

  const sync = useMutation<meeting.SyncMeetingsResponse, ApiError, void>({
    mutationFn: () => api.syncMeetings(),
    onSuccess: (r) => {
      toast.show({
        kind: "success",
        title: `招待を同期しました（追加 ${r.invitedAdded} 件・解除 ${r.invitedRemoved} 件）`,
      });
      if (r.withoutGoogleAccount.length > 0) {
        toast.show({
          kind: "warning",
          title: "Gmail 未登録のメンバーがいます",
          description: `Gmail 未登録のため Dub アドレスで招待: ${r.withoutGoogleAccount.map((x) => x.name).join("、")}`,
          durationMs: 10_000,
        });
      }
      void qc.invalidateQueries({ queryKey: MEETINGS_KEY });
    },
    onError: fail("招待を同期できませんでした"),
  });

  return { create, update, remove, sync } as MeetingMutations;
}
