// useChannelView — integration hook binding a channel's timeline to the API +
// realtime client. ALL mutations (post/edit/reaction/DELETE) are optimistic and go
// through runOptimistic (FE2 createOptimisticMutation contract): apply immediately →
// mutate → reconcile on success | rollback on failure (FRONTEND_GUIDE §Optimistic UI).
// RT gap-fill on reconnect uses afterMessageId.
import { useCallback, useEffect, useRef, useState } from "react";
import type { common } from "@dub/types";
import { useChatRuntime } from "../context";
import { useChatStore } from "../store/useChatStore";
import { runOptimistic, type StateBox } from "../store/optimistic";
import {
  ackPending,
  addPending,
  applyReactions,
  applyRealtimeEvent,
  failPending,
  markDeleted,
  mergeMessages,
  removeMessage,
  toggleReactionLocal,
  upsertMessage,
} from "../store/timeline";
import { emptyChannelView, type ChannelViewState, type PendingMessage } from "../types";
import { newClientTempId } from "../lib/ulid";
import type { ChatRealtimeClient } from "../realtime/client";
import type { Attachment, MessageDeletionPolicy } from "../api/contract";

const PAGE_SIZE = 50;

export interface UseChannelView {
  state: ChannelViewState;
  loading: boolean;
  loadOlder: () => Promise<void>;
  send: (body: string, opts?: { threadRootId?: common.MessageId; attachments?: Attachment[] }) => Promise<void>;
  resend: (clientTempId: string) => Promise<void>;
  discard: (clientTempId: string) => void;
  editMessage: (id: common.MessageId, body: string, version: number) => Promise<void>;
  deleteMessage: (id: common.MessageId, version: number) => Promise<void>;
  toggleReaction: (id: common.MessageId, emoji: string) => Promise<void>;
}

export function useChannelView(channelId: common.ChannelId): UseChannelView {
  const { api, can, currentUserId, createRealtimeClient } = useChatRuntime();
  const applyStoreEvent = useChatStore((s) => s.applyEvent);
  const setActiveChannel = useChatStore((s) => s.setActiveChannel);

  const [state, setStateRender] = useState<ChannelViewState>(() => emptyChannelView(channelId));
  const [loading, setLoading] = useState(true);
  const stateRef = useRef(state);
  const rtRef = useRef<ChatRealtimeClient | null>(null);
  // Cached workspace deletion policy — lets the optimistic delete predict the mode
  // (hard=drop vs tombstone=redact) BEFORE the request resolves, so the row updates the
  // instant the user clicks. The server's authoritative `mode` reconciles any misguess.
  const policyRef = useRef<MessageDeletionPolicy | null>(null);

  const setState = useCallback((next: ChannelViewState) => {
    stateRef.current = next;
    setStateRender(next);
  }, []);
  const box: StateBox<ChannelViewState> = { get: () => stateRef.current, set: setState };

  // Initial load + RT connect, re-run on channel change.
  useEffect(() => {
    let cancelled = false;
    const fresh = emptyChannelView(channelId);
    setState(fresh);
    setLoading(true);
    setActiveChannel(channelId);

    void (async () => {
      try {
        const page = await api.listMessages({ channelId, limit: PAGE_SIZE });
        if (cancelled) return;
        setState({
          ...stateRef.current,
          messages: mergeMessages([], page.items),
          nextCursor: page.nextCursor,
        });
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Cache the workspace deletion policy for optimistic-delete mode prediction.
      // Best-effort: on failure we predict `hard` (the product default) and still
      // reconcile against the server's authoritative mode.
      void api
        .getDeletionPolicy()
        .then((res) => {
          if (!cancelled) policyRef.current = res.policy;
        })
        .catch(() => undefined);

      const rt = createRealtimeClient();
      rtRef.current = rt;
      rt.onStatusChange((rtStatus) => {
        if (cancelled) return;
        const prev = stateRef.current.rtStatus;
        setState({ ...stateRef.current, rtStatus });
        // Gap-fill on (re)open: pull anything after the last known message.
        if (rtStatus === "open" && prev === "reconnecting") {
          const msgs = stateRef.current.messages;
          const last = msgs[msgs.length - 1];
          if (last) {
            void api
              .listMessages({ channelId, afterMessageId: last.id })
              .then((gap) => {
                if (!cancelled) setState({ ...stateRef.current, messages: mergeMessages(stateRef.current.messages, gap.items) });
              })
              .catch(() => undefined);
          }
        }
      });
      rt.onEvent((event) => {
        if (cancelled) return;
        setState(applyRealtimeEvent(stateRef.current, event, currentUserId));
        applyStoreEvent(event, currentUserId);
      });
      try {
        const ticket = await api.getWsTicket(channelId);
        if (!cancelled) rt.connect(channelId, ticket);
      } catch {
        // RT unavailable: stay on HTTP; ConnectionBanner reflects rtStatus.
      }
    })();

    return () => {
      cancelled = true;
      rtRef.current?.disconnect();
      rtRef.current = null;
    };
  }, [channelId, api, currentUserId, createRealtimeClient, applyStoreEvent, setActiveChannel, setState]);

  const loadOlder = useCallback(async () => {
    const cursor = stateRef.current.nextCursor;
    if (!cursor) return;
    const page = await api.listMessages({ channelId, cursor, limit: PAGE_SIZE });
    setState({
      ...stateRef.current,
      messages: mergeMessages(stateRef.current.messages, page.items),
      nextCursor: page.nextCursor,
    });
  }, [api, channelId, setState]);

  const sendPending = useCallback(
    async (pending: PendingMessage) => {
      await runOptimistic(box, {
        apply: (s) => addPending(s, pending),
        mutate: () => api.postMessage(pending.request),
        reconcile: (s, _vars, res) => ackPending(s, res.clientTempId, res.message),
        rollback: (_snapshot, _vars) => failPending(stateRef.current, pending.clientTempId),
      }, pending);
    },
    [api], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const send = useCallback(
    async (body: string, opts?: { threadRootId?: common.MessageId; attachments?: Attachment[] }) => {
      const pending: PendingMessage = {
        clientTempId: newClientTempId(),
        authorId: currentUserId,
        state: "sending",
        createdAt: new Date().toISOString(),
        request: {
          channelId,
          body,
          clientTempId: "",
          ...(opts?.threadRootId ? { threadRootId: opts.threadRootId } : {}),
          ...(opts?.attachments ? { attachments: opts.attachments } : {}),
        },
      };
      pending.request.clientTempId = pending.clientTempId;
      await sendPending(pending);
    },
    [channelId, currentUserId, sendPending],
  );

  const resend = useCallback(
    async (clientTempId: string) => {
      const p = stateRef.current.pending.find((x) => x.clientTempId === clientTempId);
      if (!p) return;
      // reset to sending, then retry
      setState({
        ...stateRef.current,
        pending: stateRef.current.pending.map((x) => (x.clientTempId === clientTempId ? { ...x, state: "sending" } : x)),
      });
      await runOptimistic(box, {
        apply: (s) => s,
        mutate: () => api.postMessage(p.request),
        reconcile: (s, _v, res) => ackPending(s, res.clientTempId, res.message),
        rollback: () => failPending(stateRef.current, clientTempId),
      }, p);
    },
    [api], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const discard = useCallback(
    (clientTempId: string) => {
      setState({ ...stateRef.current, pending: stateRef.current.pending.filter((p) => p.clientTempId !== clientTempId) });
    },
    [setState],
  );

  const editMessage = useCallback(
    async (id: common.MessageId, body: string, version: number) => {
      await runOptimistic(box, {
        apply: (s) => {
          const idx = s.messages.findIndex((m) => m.id === id);
          if (idx < 0) return s;
          const msgs = s.messages.slice();
          msgs[idx] = { ...msgs[idx]!, body, editedAt: new Date().toISOString() };
          return { ...s, messages: msgs };
        },
        mutate: () => api.editMessage(id, { body, version }),
        reconcile: (s, _v, res) => ({ ...s, messages: upsertMessage(s.messages, res) }),
      }, { id, body, version });
    },
    [api], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Delete is OPTIMISTIC (FRONTEND_GUIDE §Optimistic UI — no exception for delete):
  // the row updates the instant the user confirms, then the DELETE is confirmed in the
  // background. We predict the mode from the cached policy + the caller's tier
  // (chat:moderate => moderator, else member; default `hard` when the policy hasn't
  // loaded) so `hard` disappears immediately and `tombstone` shows "削除されました"
  // immediately. `reconcile` applies the server's authoritative mode (correcting any
  // misprediction — e.g. re-inserting as a tombstone), and on failure the default
  // rollback restores the snapshot so the message reappears; the caller shows an error
  // toast. The RT echo carries the same mode so other clients converge identically.
  const deleteMessage = useCallback(
    async (id: common.MessageId, _version: number) => {
      const policy = policyRef.current;
      const predicted = policy ? (can("chat:moderate") ? policy.moderator : policy.member) : "hard";
      await runOptimistic(box, {
        apply: (s) =>
          predicted === "hard"
            ? { ...s, messages: removeMessage(s.messages, id) }
            : { ...s, messages: markDeleted(s.messages, id, new Date().toISOString()) },
        mutate: () => api.deleteMessage(id),
        reconcile: (s, _v, res) =>
          res.mode === "hard" || res.message === null
            ? { ...s, messages: removeMessage(s.messages, id) }
            : { ...s, messages: upsertMessage(s.messages, res.message) },
        // rollback: default snapshot restore — the deleted row reappears on failure.
      }, { id });
    },
    [api, can], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const toggleReaction = useCallback(
    async (id: common.MessageId, emoji: string) => {
      await runOptimistic(box, {
        apply: (s) => ({ ...s, messages: toggleReactionLocal(s.messages, id, emoji, currentUserId) }),
        mutate: () => api.toggleReaction(id, { emoji }),
        // A toggle returns only { messageId, reactions } — apply the server's
        // authoritative reaction set onto the message (NOT upsertMessage, which
        // expects a full Message and would inject a phantom id=undefined entry).
        reconcile: (s, _v, res) => ({ ...s, messages: applyReactions(s.messages, res.messageId, res.reactions) }),
      }, { id, emoji });
    },
    [api, currentUserId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return { state, loading, loadOlder, send, resend, discard, editMessage, deleteMessage, toggleReaction };
}
