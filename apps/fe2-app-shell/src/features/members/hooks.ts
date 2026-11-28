// Data hooks for 運営メンバー管理: one overview query + optimistic CRUD mutations.
// Edits/adds apply optimistically (先に反映→失敗時ロールバック＋トースト); destructive
// deletes go through a ConfirmDialog in the view and await the server. All keys start
// with the feature id via queryKeys.feature("members", ...).
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCurrentEventId } from "@dub/fe3-event-action";
import { useToast } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { usePermissions } from "../../auth/AuthProvider.tsx";
import { useMembersApi } from "./MembersProvider.tsx";
import { member } from "@dub/types";
import type {
  CreateMemberRequest,
  CreateTeamRequest,
  LinkIdentityRequest,
  MembersOverview,
  OrgMember,
  UpdateMemberRequest,
  UpdateTeamRequest,
} from "./contracts.ts";

export const OVERVIEW_KEY: QueryKey = queryKeys.feature("members", "overview");
export const IDENTITY_USERS_KEY: QueryKey = queryKeys.feature("members", "identity-users");

const EMPTY_OVERVIEW: MembersOverview = { teams: [], members: [] };

/** このイベントの運営メンバー・班 (id だけ)。 */
export const EVENT_STAFF_KEY = (eventId: string): QueryKey => queryKeys.feature("members", "event-staff", eventId);

/** The header's current event, or null (= 全体の名簿をそのまま見せる、今までどおり)。 */
export function useEventStaff() {
  const api = useMembersApi();
  const { can } = usePermissions();
  const eventId = useCurrentEventId();
  const query = useQuery({
    queryKey: EVENT_STAFF_KEY(eventId ?? ""),
    queryFn: () => api.getEventStaff(eventId!),
    enabled: Boolean(eventId) && can("app:members:view"),
  });
  return { eventId, query };
}

/**
 * The overview the 運営メンバー screens show: with an event selected, only that event's staff
 * and 班 (picked from the one org-wide roster); with none, the whole roster as before.
 * `full` is always the org-wide overview (the pool to add from).
 */
export function useScopedOverview() {
  const overview = useMembersOverview();
  const { eventId, query: staff } = useEventStaff();
  const scoped = eventId !== null;
  const data =
    overview.data && (!scoped ? overview.data : staff.data ? member.scopeOverviewToEvent(overview.data, staff.data) : undefined);
  return {
    eventId,
    staff: staff.data,
    full: overview.data,
    data,
    isPending: overview.isPending || (scoped && staff.isPending),
    isError: overview.isError || (scoped && staff.isError),
    error: overview.error ?? staff.error,
    refetch: () => {
      void overview.refetch();
      if (scoped) void staff.refetch();
    },
  };
}

/** このイベントから外す (人) / 班を使う・使わない。楽観的: 先に反映 → 失敗で戻す。 */
export function useToggleEventStaff() {
  const api = useMembersApi();
  const qc = useQueryClient();
  const toast = useToast();
  type Vars = { eventId: string; kind: "person" | "team"; id: string; on: boolean };
  return useMutation<member.EventStaff, unknown, Vars, { prev: member.EventStaff | undefined }>({
    mutationFn: ({ eventId, kind, id, on }) =>
      kind === "person" ? api.setEventPerson(eventId, id, on) : api.setEventTeam(eventId, id, on),
    onMutate: async ({ eventId, kind, id, on }) => {
      const key = EVENT_STAFF_KEY(eventId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<member.EventStaff>(key);
      const base = prev ?? { eventId, personIds: [], teamIds: [] };
      const field = kind === "person" ? "personIds" : "teamIds";
      const set = new Set(base[field]);
      if (on) set.add(id);
      else set.delete(id);
      qc.setQueryData<member.EventStaff>(key, { ...base, [field]: [...set] });
      return { prev };
    },
    onError: (err, { eventId }, ctx) => {
      qc.setQueryData(EVENT_STAFF_KEY(eventId), ctx?.prev);
      toast.show({ kind: "error", title: messageFor(err, "イベントの運営メンバーを変更できませんでした") });
    },
    onSettled: (_d, _e, { eventId }) => {
      void qc.invalidateQueries({ queryKey: EVENT_STAFF_KEY(eventId) });
    },
  });
}

/** このイベントに招待: アカウントのある人をすぐ運営メンバーに入れ、本人へ通知する。楽観的に先に入れる。 */
export function useInviteToEvent() {
  const api = useMembersApi();
  const qc = useQueryClient();
  const toast = useToast();
  type Vars = { eventId: string; eventTitle: string; personId: string; name: string };
  return useMutation<member.InviteEventStaffResponse, unknown, Vars, { prev: member.EventStaff | undefined }>({
    mutationFn: ({ eventId, eventTitle, personId }) => api.inviteToEvent(eventId, { personId, eventTitle }),
    onMutate: async ({ eventId, personId }) => {
      const key = EVENT_STAFF_KEY(eventId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<member.EventStaff>(key);
      const base = prev ?? { eventId, personIds: [], teamIds: [] };
      qc.setQueryData<member.EventStaff>(key, { ...base, personIds: [...new Set([...base.personIds, personId])] });
      return { prev };
    },
    onSuccess: (res, { eventId, name }) => {
      qc.setQueryData(EVENT_STAFF_KEY(eventId), res.staff);
      toast.show(
        res.notified
          ? { kind: "success", title: `${name}さんを招待し、通知を送りました` }
          : { kind: "warning", title: `${name}さんを運営メンバーに入れましたが、通知は送れませんでした` },
      );
    },
    onError: (err, { eventId }, ctx) => {
      qc.setQueryData(EVENT_STAFF_KEY(eventId), ctx?.prev);
      toast.show({ kind: "error", title: messageFor(err, "招待できませんでした") });
    },
    onSettled: (_d, _e, { eventId }) => {
      void qc.invalidateQueries({ queryKey: EVENT_STAFF_KEY(eventId) });
    },
  });
}

export function useMembersOverview() {
  const api = useMembersApi();
  const { can } = usePermissions();
  const canReadRoster = can("members:roster_view");
  return useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => (canReadRoster ? api.getOverview() : api.getOrgOverview()),
    // /me が読めるまで can() は全部 false。範囲を決めてから取りにいく。
    enabled: can("app:members:view"),
  });
}

/** Roster login accounts — the candidate pool for linking (#1). Cached a bit longer
 *  than the overview since the account set changes less often than 組織図 edits. */
export function useIdentityUsers() {
  const api = useMembersApi();
  return useQuery({ queryKey: IDENTITY_USERS_KEY, queryFn: () => api.listIdentityUsers(), staleTime: 60_000 });
}

function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

/** Generic optimistic overview mutation: snapshot → patch cache → rollback on error. */
function useOverviewMutation<TVars, TData>(config: {
  mutationFn: (vars: TVars) => Promise<TData>;
  optimistic?: (prev: MembersOverview, vars: TVars) => MembersOverview;
  successMessage: string;
  errorFallback: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TData, unknown, TVars, { prev: MembersOverview | undefined }>({
    mutationFn: config.mutationFn,
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: OVERVIEW_KEY });
      const prev = qc.getQueryData<MembersOverview>(OVERVIEW_KEY);
      if (config.optimistic) {
        qc.setQueryData<MembersOverview>(OVERVIEW_KEY, (old) => config.optimistic!(old ?? EMPTY_OVERVIEW, vars));
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx) qc.setQueryData(OVERVIEW_KEY, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, config.errorFallback) });
    },
    onSuccess: () => {
      toast.show({ kind: "success", title: config.successMessage });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
  });
}

// ---- teams ----
export function useCreateTeam() {
  const api = useMembersApi();
  const qc = useQueryClient();
  const eventId = useCurrentEventId();
  return useOverviewMutation<CreateTeamRequest, unknown>({
    // イベントを選んでいる時に作ったチームは、そのイベントの班にもなる。
    mutationFn: async (input) => {
      const res = await api.createTeam(eventId ? { ...input, eventId } : input);
      if (eventId) void qc.invalidateQueries({ queryKey: EVENT_STAFF_KEY(eventId) });
      return res;
    },
    successMessage: "チームを追加しました",
    errorFallback: "チームを追加できませんでした",
  });
}

export function useUpdateTeam() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; patch: UpdateTeamRequest }, unknown>({
    mutationFn: ({ id, patch }) => api.updateTeam(id, patch),
    optimistic: (prev, { id, patch }) => ({
      ...prev,
      teams: prev.teams.map((t) => (t.id === id ? { ...t, ...stripUndefined(patch) } : t)),
    }),
    successMessage: "チームを更新しました",
    errorFallback: "チームを更新できませんでした",
  });
}

export function useDeleteTeam() {
  const api = useMembersApi();
  return useOverviewMutation<string, unknown>({
    mutationFn: (id) => api.deleteTeam(id),
    optimistic: (prev, id) => ({
      teams: prev.teams.filter((t) => t.id !== id),
      members: prev.members.map((m) => ({ ...m, teamIds: m.teamIds.filter((t) => t !== id) })),
    }),
    successMessage: "チームを削除しました",
    errorFallback: "チームを削除できませんでした",
  });
}

// ---- members ----
export function useCreateMember() {
  const api = useMembersApi();
  const qc = useQueryClient();
  const eventId = useCurrentEventId();
  return useOverviewMutation<CreateMemberRequest, unknown>({
    // イベントを選んでいる時に追加した人は、そのイベントの運営メンバーにもなる。
    mutationFn: async (input) => {
      const res = await api.createMember(eventId ? { ...input, eventId } : input);
      if (eventId) void qc.invalidateQueries({ queryKey: EVENT_STAFF_KEY(eventId) });
      return res;
    },
    successMessage: "メンバーを追加しました",
    errorFallback: "メンバーを追加できませんでした",
  });
}

export function useUpdateMember() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; patch: UpdateMemberRequest }, OrgMember>({
    mutationFn: ({ id, patch }) => api.updateMember(id, patch),
    optimistic: (prev, { id, patch }) => ({
      ...prev,
      members: prev.members.map((m) =>
        m.id === id ? { ...m, ...stripUndefined({ ...patch, version: undefined }) } : m,
      ),
    }),
    successMessage: "メンバーを更新しました",
    errorFallback: "メンバーを更新できませんでした",
  });
}

/** 組織図までの編集。運営での項目だけ送る (optimistic は useUpdateMember と同じ)。 */
export function useUpdateMemberOrg() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; patch: member.UpdateMemberOrgRequest }, OrgMember>({
    mutationFn: ({ id, patch }) => api.updateMemberOrg(id, patch),
    optimistic: (prev, { id, patch }) => ({
      ...prev,
      members: prev.members.map((m) =>
        m.id === id ? { ...m, ...stripUndefined({ ...patch, version: undefined }) } : m,
      ),
    }),
    successMessage: "メンバーを更新しました",
    errorFallback: "メンバーを更新できませんでした",
  });
}

export function useDeleteMember() {
  const api = useMembersApi();
  return useOverviewMutation<string, unknown>({
    mutationFn: (id) => api.deleteMember(id),
    optimistic: (prev, id) => ({ ...prev, members: prev.members.filter((m) => m.id !== id) }),
    successMessage: "メンバーを削除しました",
    errorFallback: "メンバーを削除できませんでした",
  });
}

/** Link (or unlink with identityUserId=null) a member to a login account (#1). Optimistic:
 *  the linked account shows immediately, rolling back on error (e.g. 409 already-linked). */
export function useLinkIdentity() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; req: LinkIdentityRequest }, OrgMember>({
    mutationFn: ({ id, req }) => api.linkIdentity(id, req),
    optimistic: (prev, { id, req }) => ({
      ...prev,
      members: prev.members.map((m) =>
        m.id === id ? { ...m, identityUserId: req.identityUserId, version: m.version + 1 } : m,
      ),
    }),
    successMessage: "アカウントを紐付けました",
    errorFallback: "アカウントを紐付けできませんでした",
  });
}

export function useUnlinkIdentity() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; version: number }, OrgMember>({
    mutationFn: ({ id, version }) => api.updateMember(id, { identityUserId: null, version }),
    optimistic: (prev, { id }) => ({
      ...prev,
      members: prev.members.map((m) => (m.id === id ? { ...m, identityUserId: null, version: m.version + 1 } : m)),
    }),
    successMessage: "紐付けを解除しました",
    errorFallback: "紐付けを解除できませんでした",
  });
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
