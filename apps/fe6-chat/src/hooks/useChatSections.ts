// Org-wide sidebar sections (one shared set): load for everyone; the optimistic create /
// rename / delete / move below are only wired to UI for chat:manage_sections holders.
// Every mutation applies locally first and reverts only its own change on failure
// (targeted rollback, so a concurrent edit is not clobbered), then toasts.
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@dub/ui";
import type { common } from "@dub/types";
import type { ChatApiClient } from "../api/client";
import { ChatApiError } from "../api/client";
import type { ChatSection } from "../api/contract";
import { mapChatError } from "../lib/errors";

export interface ChatSectionsState {
  sections: ChatSection[];
  assignments: Record<common.ChannelId, string>;
  loaded: boolean;
}

export interface ChatSectionsApi extends ChatSectionsState {
  create: (name: string, assignChannelId?: common.ChannelId) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  move: (channelId: common.ChannelId, sectionId: string | null) => void;
}

const TEMP_PREFIX = "tmp_sec_";
/** Optimistic section not yet acknowledged by the server (no actions on it yet). */
export const isPendingSection = (id: string): boolean => id.startsWith(TEMP_PREFIX);

const reason = (err: unknown) => mapChatError(err instanceof ChatApiError ? err.code : "INTERNAL").message;

export function useChatSections(api: ChatApiClient): ChatSectionsApi {
  const { show } = useToast();
  const [state, setState] = useState<ChatSectionsState>({ sections: [], assignments: {}, loaded: false });
  const tempSeq = useRef(0);
  // Snapshot for rollbacks, read synchronously (setState updaters run later).
  const current = useRef(state);
  current.current = state;

  useEffect(() => {
    let cancelled = false;
    // Sections are an overlay on the channel list: a failure degrades to "no sections".
    void api
      .listSections()
      .then((res) => !cancelled && setState({ sections: res.items, assignments: res.assignments, loaded: true }))
      .catch(() => !cancelled && setState((s) => ({ ...s, loaded: true })));
    return () => {
      cancelled = true;
    };
  }, [api]);

  const fail = useCallback(
    (title: string, err: unknown) => show({ kind: "error", title, description: reason(err) }),
    [show],
  );

  const setAssignment = (
    assignments: Record<string, string>,
    channelId: string,
    sectionId: string | null,
  ): Record<string, string> => {
    const next = { ...assignments };
    if (sectionId === null) delete next[channelId];
    else next[channelId] = sectionId;
    return next;
  };

  const move = useCallback(
    (channelId: common.ChannelId, sectionId: string | null) => {
      const prev = current.current.assignments[channelId] ?? null;
      setState((s) => ({ ...s, assignments: setAssignment(s.assignments, channelId, sectionId) }));
      api.setChannelSection(channelId, sectionId).catch((err: unknown) => {
        setState((s) =>
          (s.assignments[channelId] ?? null) === sectionId
            ? { ...s, assignments: setAssignment(s.assignments, channelId, prev) }
            : s,
        );
        fail("チャンネルを移動できませんでした", err);
      });
    },
    [api, fail],
  );

  const create = useCallback(
    (name: string, assignChannelId?: common.ChannelId) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const tempId = `${TEMP_PREFIX}${++tempSeq.current}`;
      const prevAssignment = assignChannelId ? (current.current.assignments[assignChannelId] ?? null) : null;
      setState((s) => {
        const position = s.sections.reduce((max, x) => Math.max(max, x.position + 1), 0);
        const temp: ChatSection = { id: tempId, name: trimmed, position, createdAt: new Date().toISOString() };
        return {
          ...s,
          sections: [...s.sections, temp],
          assignments: assignChannelId ? setAssignment(s.assignments, assignChannelId, tempId) : s.assignments,
        };
      });
      const swapTemp = (real: ChatSection) =>
        setState((s) => ({
          ...s,
          sections: s.sections.map((x) => (x.id === tempId ? real : x)),
          assignments: Object.fromEntries(Object.entries(s.assignments).map(([c, sec]) => [c, sec === tempId ? real.id : sec])),
        }));
      api
        .createSection(trimmed)
        .then(async (real) => {
          swapTemp(real);
          if (assignChannelId) {
            await api.setChannelSection(assignChannelId, real.id).catch((err: unknown) => {
              setState((s) =>
                s.assignments[assignChannelId] === real.id
                  ? { ...s, assignments: setAssignment(s.assignments, assignChannelId, prevAssignment) }
                  : s,
              );
              fail("チャンネルを移動できませんでした", err);
            });
          }
        })
        .catch((err: unknown) => {
          setState((s) => ({
            ...s,
            sections: s.sections.filter((x) => x.id !== tempId),
            assignments: Object.fromEntries(Object.entries(s.assignments).filter(([, sec]) => sec !== tempId)),
          }));
          fail("セクションを作成できませんでした", err);
        });
    },
    [api, fail],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const prevName = current.current.sections.find((x) => x.id === id)?.name ?? null;
      setState((s) => ({ ...s, sections: s.sections.map((x) => (x.id === id ? { ...x, name: trimmed } : x)) }));
      api.updateSection(id, { name: trimmed }).catch((err: unknown) => {
        setState((s) => ({
          ...s,
          sections: s.sections.map((x) => (x.id === id && x.name === trimmed && prevName !== null ? { ...x, name: prevName } : x)),
        }));
        fail("セクション名を変更できませんでした", err);
      });
    },
    [api, fail],
  );

  const remove = useCallback(
    (id: string) => {
      const removed = current.current.sections.find((x) => x.id === id);
      const removedAssignments = Object.entries(current.current.assignments).filter(([, sec]) => sec === id);
      setState((s) => ({
        ...s,
        sections: s.sections.filter((x) => x.id !== id),
        assignments: Object.fromEntries(Object.entries(s.assignments).filter(([, sec]) => sec !== id)),
      }));
      api.deleteSection(id).catch((err: unknown) => {
        setState((s) => {
          if (!removed || s.sections.some((x) => x.id === id)) return s;
          const assignments = { ...s.assignments };
          // Restore only channels the user has not re-homed meanwhile.
          for (const [c, sec] of removedAssignments) if (!(c in assignments)) assignments[c] = sec;
          return { ...s, sections: [...s.sections, removed], assignments };
        });
        fail("セクションを削除できませんでした", err);
      });
    },
    [api, fail],
  );

  return { ...state, create, rename, remove, move };
}
